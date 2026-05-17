import type { CompletionSound } from "./generalSettings";

export type CompletionSoundOption = {
  value: CompletionSound;
  label: string;
};

type PlayableCompletionSound = Exclude<CompletionSound, "off">;

const SOUND_URLS: Record<PlayableCompletionSound, string> = {
  chime: "/sounds/chime.wav",
  ding: "/sounds/ding.wav",
  pop: "/sounds/pop.wav",
};

export const COMPLETION_SOUND_OPTIONS: readonly CompletionSoundOption[] = [
  { value: "off", label: "Off" },
  { value: "chime", label: "Chime" },
  { value: "ding", label: "Ding" },
  { value: "pop", label: "Pop" },
];

const audioCache = new Map<PlayableCompletionSound, HTMLAudioElement>();

function getAudioElement(sound: PlayableCompletionSound): HTMLAudioElement | null {
  if (typeof Audio === "undefined") {
    return null;
  }

  const existing = audioCache.get(sound);
  if (existing) {
    return existing;
  }

  const audio = new Audio(SOUND_URLS[sound]);
  audio.preload = "auto";
  audioCache.set(sound, audio);
  return audio;
}

export async function playCompletionSound(sound: CompletionSound): Promise<boolean> {
  if (sound === "off") {
    return false;
  }

  const audio = getAudioElement(sound);
  if (!audio) {
    return false;
  }

  audio.pause();
  try {
    audio.currentTime = 0;
  } catch {
    // Ignore media reset failures and attempt playback anyway.
  }

  try {
    const playResult = audio.play();
    if (playResult && typeof playResult.then === "function") {
      await playResult;
    }
    return true;
  } catch {
    return false;
  }
}

export function stopCompletionSoundPlayback(): void {
  for (const audio of audioCache.values()) {
    audio.pause();
    try {
      audio.currentTime = 0;
    } catch {
      // Ignore media reset failures during cleanup.
    }
  }
}
