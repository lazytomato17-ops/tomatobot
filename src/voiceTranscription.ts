// src/voiceTranscription.ts
import { EndBehaviorType, VoiceConnection, createAudioPlayer, createAudioResource, StreamType, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import * as prism from 'prism-media';
import Groq from 'groq-sdk';
import { toFile } from 'groq-sdk';
import { TextChannel } from 'discord.js';
import { Readable } from 'stream'; // 👈 新しく追加

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// 🚨 async を追加しています
export async function startGhostCamera(connection: VoiceConnection, ghostChannel: TextChannel) {
    
    console.log('⏳ [カメラ] VC接続の完了を待機中...');
    try {
        // 🚨 【超重要】VC接続が「Ready」になるまで待ってから儀式を始めないと、パケットが虚無に消える！
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
        console.log('✅ [カメラ] VC接続完了！ポートを開放します...');
    } catch (error) {
        console.error('❌ [カメラ] VC接続タイムアウト:', error);
        return;
    }

    // 魔法の儀式：Botが確実に喋るふりをして受信ポートを開ける（約1秒間無音を流す）
    const player = createAudioPlayer();
    connection.subscribe(player);

    class SilenceStream extends Readable {
        private chunks = 0;
        _read() {
            if (this.chunks >= 50) { // 50パケット = 約1秒
                this.push(null);
            } else {
                this.push(Buffer.alloc(960 * 4)); // 20msの無音PCM
                this.chunks++;
            }
        }
    }
    
    const resource = createAudioResource(new SilenceStream(), { inputType: StreamType.Raw });
    player.play(resource);

    const receiver = connection.receiver;
    console.log('🎙️ [カメラ] 音声リスニングを開始しました。待機中...');

    receiver.speaking.on('start', (userId) => {
        console.log(`🗣️ [カメラ] ユーザー ${userId} が喋り始めました！`);

        const audioStream = receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
        });

        // ⏱️ 長さチェック用：Discordから送られてくる音声パケットの数を数える
        let packetCount = 0;
        audioStream.on('data', () => packetCount++);

        // 🛠️ 【真の解決策】生の音声をそのまま「Oggの箱」に詰める
        const oggStream = new (prism.opus as any).OggLogicalBitstream({
            opusHead: new (prism.opus as any).OpusHead({
                channelCount: 2,
                sampleRate: 48000,
            }),
            pageSizeControl: { maxPackets: 10 },
        });

        const chunks: Buffer[] = [];
        audioStream.pipe(oggStream);

        oggStream.on('data', (chunk) => chunks.push(chunk));
        oggStream.on('end', async () => {
            // 25パケット未満（約0.5秒未満）のノイズや息継ぎは無視する
            if (packetCount < 25) return;
            
            const oggBuffer = Buffer.concat(chunks);

            try {
                console.log('🚀 [カメラ] 音声をGroq(Whisper)へ直接送信中...');
                const file = await toFile(oggBuffer, 'audio.ogg');
                const transcription = await groq.audio.transcriptions.create({
                    file: file,
                    model: 'whisper-large-v3',
                    language: 'ja',
                });
                
                const text = transcription.text?.trim();
                if (text && text.length > 0) {
                    console.log(`✅ [文字起こし成功]: ${text}`);
                    ghostChannel.send(`🎥 **[カメラ音声: <@${userId}>]**\n「${text}」`);
                }
            } catch (e: any) {
                console.error('❌ Groq API エラー:', e.message);
            }
        });
    });
}