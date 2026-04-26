// src/voiceTranscription.ts
import { EndBehaviorType, VoiceConnection, createAudioPlayer, createAudioResource, StreamType } from '@discordjs/voice';
import * as prism from 'prism-media';
import Groq from 'groq-sdk';
import { toFile } from 'groq-sdk';
import { TextChannel } from 'discord.js';
import { PassThrough } from 'stream';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export function startGhostCamera(connection: VoiceConnection, ghostChannel: TextChannel) {
    
    // 魔法の儀式：Botが喋るふりをして受信ポートを開ける
    const player = createAudioPlayer();
    const silence = new PassThrough();
    silence.end(Buffer.alloc(960 * 4));
    const resource = createAudioResource(silence, { inputType: StreamType.Raw });
    connection.subscribe(player);
    player.play(resource);

    const receiver = connection.receiver;
    console.log('🎙️ [カメラ] 音声リスニングを開始しました。待機中...');

    receiver.speaking.on('start', (userId) => {
        console.log(`🗣️ [カメラ] ユーザー ${userId} が喋り始めました！`);

        const audioStream = receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
        });

        // ⏱️ 長さチェック用：Discordから送られてくる音声パケット（約20ms）の数を数える
        let packetCount = 0;
        audioStream.on('data', () => packetCount++);

        // 🛠️ 【真の解決策】
        // 翻訳機（デコーダー）もFFmpegも使わず、生の音声をそのまま「Oggの箱」に詰めるだけ！
        const oggStream = new prism.opus.OggLogicalBitstream({
            opusHead: new prism.opus.OpusHead({
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
                
                // 📦 出来上がったOggデータを、そのままファイルとしてAPIに投げる
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