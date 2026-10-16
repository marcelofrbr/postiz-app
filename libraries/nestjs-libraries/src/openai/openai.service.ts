import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'sk-proj-',
});

const VoicePrompt = z.object({
  voice: z.string(),
});

const ClipsPrompt = z.object({
  clips: z.array(
    z.object({
      from: z.number().describe('Number of the first line of the clip'),
      to: z.number().describe('Number of the last line of the clip'),
      title: z.string().describe('Short title of the clip'),
      content: z
        .string()
        .describe('Social media post to publish the clip with, no hashtags'),
    })
  ),
});

/**
 * Camada legada do OpenAI.
 *
 * A maioria dos metodos foi migrada para `AiTextService` e `AiImageService`
 * (Fase 1 — Blocos B e C), que respeitam a configuracao por workspace.
 *
 * Os metodos abaixo sao mantidos APENAS para features dormentes
 * (HeyGen e ImageSlides) que ainda nao tem upstream alternativo. Quando
 * essas features forem revisadas (Bloco F), este arquivo deve ser
 * removido completamente.
 */
@Injectable()
export class OpenaiService {
  // The model answers with line numbers and not times, so a clip can only
  // start and end where the transcript really has a boundary
  async pickClips(
    title: string,
    language: string,
    segments: { start: number; end: number; text: string }[],
    maxClips: number
  ) {
    const { clips } = (
      await openai.chat.completions.parse(
        {
          model: 'gpt-4.1',
          messages: [
            {
              role: 'system',
              content: `You are an assistant that takes the transcript of a video and picks the parts that will work best as short vertical clips for social media.
Every line of the transcript is "number [start seconds - end seconds] text".
Pick up to ${maxClips} clips, best first. A clip is a range of consecutive lines that starts with a hook, makes one complete point and is understandable without the rest of the video.
The length of a clip is the end of its last line minus the start of its first line: it must be between 20 and 90 seconds, never longer, so check the numbers before answering.
Clips must not overlap. Write the title and the post in this language, whatever the language of these instructions: ${language}.`,
            },
            {
              role: 'user',
              content: `title: ${title}\n\n${segments
                .map(
                  (p, index) =>
                    `${index} [${p.start.toFixed(1)} - ${p.end.toFixed(1)}] ${
                      p.text
                    }`
                )
                .join('\n')}`,
            },
          ],
          response_format: zodResponseFormat(ClipsPrompt, 'clipsPrompt'),
        },
        // shorter than the activity: an attempt that was given up on must not
        // still be running, and storing clips, when its retry gets there
        { timeout: 8 * 60 * 1000, maxRetries: 0 }
      )
    ).choices[0].message.parsed || { clips: [] };

    return clips;
  }

  /** Usado por HeygenProvider para gerar texto narrado em estilo conversacional. */
  async generateVoiceFromText(prompt: string) {
    return (
      (
        await openai.chat.completions.parse({
          model: 'gpt-4.1',
          messages: [
            {
              role: 'system',
              content: `You are an assistant that takes a social media post and convert it to a normal human voice, to be later added to a character, when a person talk they don\'t use "-", and sometimes they add pause with "..." to make it sounds more natural, make sure you use a lot of pauses and make it sound like a real person`,
            },
            {
              role: 'user',
              content: `prompt: ${prompt}`,
            },
          ],
          response_format: zodResponseFormat(VoicePrompt, 'voice'),
        })
      ).choices[0].message.parsed?.voice || ''
    );
  }

  /** Usado por ImagesSlides para quebrar um tema em slides com voiceText/imagePrompt. */
  async generateSlidesFromText(text: string) {
    for (let i = 0; i < 3; i++) {
      try {
        const message = `You are an assistant that takes a text and break it into slides, each slide should have an image prompt and voice text to be later used to generate a video and voice, image prompt should capture the essence of the slide and also have a back dark gradient on top, image prompt should not contain text in the picture, generate between 3-5 slides maximum`;
        const parse =
          (
            await openai.chat.completions.parse({
              model: 'gpt-4.1',
              messages: [
                {
                  role: 'system',
                  content: message,
                },
                {
                  role: 'user',
                  content: text,
                },
              ],
              response_format: zodResponseFormat(
                z.object({
                  slides: z
                    .array(
                      z.object({
                        imagePrompt: z.string(),
                        voiceText: z.string(),
                      })
                    )
                    .describe('an array of slides'),
                }),
                'slides'
              ),
            })
          ).choices[0].message.parsed?.slides || [];

        return parse;
      } catch (err) {
        console.log(err);
      }
    }

    return [];
  }
}
