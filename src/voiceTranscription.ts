// src/voiceTranscription.ts
import { EndBehaviorType, VoiceConnection, createAudioPlayer, createAudioResource, StreamType, VoiceConnectionStatus } from '@discordjs/voice';
import * as prism from 'prism-media';
import Groq from 'groq-sdk';
import { toFile } from 'groq-sdk';
import { TextChannel } from 'discord.js';
import { Readable } from 'stream';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export function startGhostCamera(connection: VoiceConnection, ghostChannel: TextChannel) {
    console.log('⏳ [カメラ] VC接続を監視中...');

    // タイムアウトをなくし、状態の変化を監視する（確実なタイミングを狙う）
    connection.on('stateChange', (oldState, newState) => {
        console.log(`📡 [VCステータス]: ${oldState.status} -> ${newState.status}`);

        // 完全に準備が整った瞬間（Ready）に、1回だけ儀式を実行する
        if (newState.status === VoiceConnectionStatus.Ready && oldState.status !== VoiceConnectionStatus.Ready) {
            console.log('✅ [カメラ] VC接続が完了しました！受信ポートを開放します...');
            openReceiverPort(connection, ghostChannel);
        }
    });

    connection.on('error', (error) => {
        console.error('❌ [カメラ] VCエラー:', error.message);
    });
}

// 儀式と録音の処理（Readyになったら呼び出される）
function openReceiverPort(connection: VoiceConnection, ghostChannel: TextChannel) {
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

        let packetCount = 0;
        audioStream.on('data', () => packetCount++);

        // 生の音声をそのまま「Oggの箱」に詰める
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
            // 短すぎるノイズは無視
            if (packetCount < 25) return;
            
            const oggBuffer = Buffer.concat(chunks);

            try {
                console.log('🚀 [カメラ] 音声をGroq(Whisper)へ送信中...');
                const file = await toFile(oggBuffer, 'audio.ogg');
                const transcription = await groq.audio.transcriptions.create({
                    file: file,
                    model: 'whisper-large-v3',
                    language: 'ja',
                });
                
                const text = transcription.text?.trim();
                if (text && text.length > 0) {
                    console.log(`✅ [文字起こし成功]: ${text}`);
                    ghostChannel.send(`🎥 **[カメラ音声: <@${userId}>]**\n「${text}」`).catch(() => {});
                }
            } catch (e: any) {
                console.error('❌ Groq API エラー:', e.message);
            }
        });
    });
}