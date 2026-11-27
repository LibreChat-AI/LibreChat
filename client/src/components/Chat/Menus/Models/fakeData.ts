import { EModelEndpoint, AuthType } from 'librechat-data-provider';
import type { TModelSpec } from 'librechat-data-provider';

export const data: TModelSpec[] = [
  {
    name: 'commander_01',
    label: 'Commander in Chief',
    description:
      'Salute your president, soldier! Salute your president, soldier! Salute your president, soldier!',
    iconURL: 'https://i.kym-cdn.com/entries/icons/facebook/000/017/252/2f0.jpg',
    // iconURL: EModelEndpoint.openAI,
    preset: {
      endpoint: 'Ollama',
      greeting: 'My fellow Americans,',
      // 'endpointType': EModelEndpoint.custom,
      frequency_penalty: 0,
      // 'imageDetail': 'auto',
      model: 'command-r',
      presence_penalty: 0,
      promptPrefix: null,
      resendFiles: false,
      temperature: 0.8,
      top_p: 0.5,
    },
    authType: AuthType.SYSTEM_DEFINED,
  },
  {
    name: 'vision_pro',
    label: 'Vision Pro',
    description:
      'Salute your president, soldier! Salute your president, soldier! Salute your president, soldier!',
    // iconURL: 'https://i.ytimg.com/vi/SaneSRqePVY/maxresdefault.jpg',
    iconURL: EModelEndpoint.openAI, // Allow using project-included icons
    preset: {
      modelLabel: 'Vision Helper',
      greeting: "What's up!!",
      endpoint: EModelEndpoint.openAI,
      model: 'gpt-4-turbo',
      promptPrefix:
        'Examine images closely to understand its style, colors, composition, and other elements. Then, craft a detailed prompt to that closely resemble the original. Your focus is on accuracy in replicating the style, colors, techniques, and details of the original image in written form. Your prompt must be excruciatingly detailed as it will be given to an image generating AI for image generation. \n',
      temperature: 0.8,
      top_p: 1,
    },
    authType: AuthType.SYSTEM_DEFINED,
  },
];
