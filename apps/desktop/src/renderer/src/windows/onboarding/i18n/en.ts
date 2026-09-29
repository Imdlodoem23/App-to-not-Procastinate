/** English strings of the onboarding (same shape as `es.ts`, `OnboardingMessages`). */
import type { OnboardingMessages } from './es';

export const ONBOARDING_EN: OnboardingMessages = {
  name: 'First steps',
  title: (step: string, n: number, total: number): string => `${step} · step ${n} of ${total}`,
  /** Screen readers, on a step change: «Guardián · paso 2 de 5. El guardián aplica…». */
  stepAnnouncement: (title: string, sentence: string): string => `${title}. ${sentence}`,
  steps: {
    welcome: 'Welcome',
    guardian: 'Guardian',
    extension: 'Extension',
    camera: 'Camera',
    'first-block': 'First block',
  },
  status: {
    welcome: 'About 2 minutes',
    guardianTodo: 'Not installed',
    guardianStopped: 'Stopped',
    guardianChecking: 'Checking…',
    guardianInstalling: 'Installing…',
    guardianDone: 'Installed',
    extensionTodo: 'Not connected',
    extensionDone: 'Connected',
    cameraUnavailable: 'Comes with Study Mode',
    cameraOptional: 'Optional',
    firstBlockTodo: 'Ready to create',
    firstBlockDone: 'Created',
  },
  sentences: {
    welcome:
      'Céntrate blocks what distracts you, and the block holds even if you close the app or restart.',
    guardian:
      'The guardian enforces blocks on its own. Installing it asks for administrator permission once.',
    guardianDone: 'Installed: it enforces blocks even if you close the app.',
    extension:
      'The extension blocks instantly inside the browser. Install it and type this code into it:',
    extensionNoGuardian:
      'The extension blocks instantly inside the browser. Pairing it needs the guardian.',
    extensionDone: 'Connected: the browser now blocks instantly.',
    camera:
      'Study Mode will use the camera to see whether you are studying, and no image ever leaves your computer.',
    firstBlock: 'Your first block is already typed: Enter to review it and Enter again to start.',
  },
  firstBlockPhrase: 'no YouTube for 25 minutes',
  fieldLabel: 'What do you want to do?',
  rowLabel: 'Step actions',
  tiles: {
    start: 'Start',
    skip: 'Skip',
    install: 'Install',
    repair: 'Repair',
    installing: 'Installing…',
    continue: 'Continue',
    guideChromium: 'Chrome & Edge',
    guideFirefox: 'Firefox',
    camera: 'Test camera',
    create: 'Create block',
  },
  help: {
    start: 'Guardian, extension and your first block, in about 2 minutes',
    install: 'Asks for administrator permission only once',
    continue: 'On to the next step',
    guideChromium: 'Step by step in Chrome, Edge, Brave and others',
    guideFirefox: 'Step by step in Firefox',
    camera: 'Checks that the camera can see you',
    /** Step 4's «Continuar» while Study Mode is not there. */
    cameraLater: 'The camera test comes with Study Mode',
    create: 'Review the block and confirm it with Enter',
    skip: {
      welcome: 'Straight to the app; you can repeat these steps from Settings',
      guardian: 'Nothing is blocked without the guardian; install it from Settings',
      extension: 'You can pair it later from Settings',
      camera: 'The camera is optional',
      'first-block': 'Finish without creating a block',
    },
  },
  install: {
    installed: 'Installed: waiting for it to answer…',
    'already-installed': 'It was already installed',
    cancelled: 'It cannot be installed without administrator permission',
    unsupported: 'It cannot be installed from the app here: see the guide on the web',
  },
  pairing: {
    expires: 'Expires in',
    expired: 'The code has expired',
    newCode: 'New code',
    codeLabel: (code: string): string => `Pairing code: ${code}`,
    port: (port: string): string => `Port: ${port}`,
  },
  cameraUnavailable: 'The camera test comes with Study Mode',
  saveFailed: 'Could not save: try again',
};
