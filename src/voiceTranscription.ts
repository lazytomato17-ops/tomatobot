// src/voiceTranscription.ts
import { EndBehaviorType, VoiceConnection } from '@discordjs/voice';
import * as prism from 'prism-media';
import Groq from 'groq-sdk';
import { toFile } from 'groq-sdk';
import { TextChannel } from 'discord.js';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * 霊界カメラのリスニングを開始する
 * @param connection 対象のVCのVoiceConnection
 * @param ghostChannel 文字起こしを送信する霊界のテキストチャンネル
 */
export function startGhostCamera(connection: VoiceConnection, ghostChannel: TextChannel) {
    const receiver = connection.receiver;

    // 誰かが喋り始めたらイベント発火
    receiver.speaking.on('start', (userId) => {
        // 対象ユーザーの音声ストリームを取得（無音が1秒続いたら終了して処理に回す）
        const audioStream = receiver.subscribe(userId, {
            end: {
                behavior: EndBehaviorType.AfterSilence,
                duration: 1000,
            },
        });

        // Opus形式から生のPCMデータにデコード
        const pcmStream = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
        const chunks: Buffer[] = [];

        audioStream.pipe(pcmStream);

        pcmStream.on('data', (chunk) => {
            chunks.push(chunk);
        });

        pcmStream.on('end', async () => {
            const pcmBuffer = Buffer.concat(chunks);
            // 短すぎる音声（0.5秒未満のノイズや咳払いなど）はスキップしてAPI節約
            if (pcmBuffer.length < 48000 * 2 * 0.5) return; 

            try {
                // PCMをWAVに変換（Renderのメモリ節約のためオンメモリで処理）
                const wavBuffer = encodePCMToWAV(pcmBuffer, 48000, 2);
                
                // Groq SDKのtoFileを使ってBufferを送信可能な形式に
                const file = await toFile(wavBuffer, 'audio.wav');

                const transcription = await groq.audio.transcriptions.create({
                    file: file,
                    model: 'whisper-large-v3',
                    language: 'ja',
                    prompt: '悲鳴、ゲーム実況、焦り、絶叫、リーサルカンパニー', // コンテキストを与えて認識精度を上げる
                });

                const text = transcription.text?.trim();
                if (text && text.length > 0) {
                    // 霊界チャンネルに実況として送信
                    ghostChannel.send(`🎥 **[カメラ音声: <@${userId}>]**\n「${text}」`);
                }
            } catch (error) {
                console.error('Transcription error:', error);
            }
        });
    });
}

/**
 * 生のPCMデータをWAVフォーマット（ヘッダー付き）に変換する軽量関数
 * ffmpegを使わずに直接WAV化するためのハックです。
 */
function encodePCMToWAV(pcmData: Buffer, sampleRate: number, numChannels: number): Buffer {
    const byteRate = sampleRate * numChannels * 2;
    const blockAlign = numChannels * 2;
    const buffer = Buffer.alloc(44 + pcmData.length);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + pcmData.length, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16); 
    buffer.writeUInt16LE(1, 20); 
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(16, 34); 
    buffer.write('data', 36);
    buffer.writeUInt32LE(pcmData.length, 40);

    pcmData.copy(buffer, 44);
    return buffer;
}
