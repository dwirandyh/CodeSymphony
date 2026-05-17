import {
  DEFAULT_COMPLETION_SOUND_VOLUME,
  type CompletionSound,
} from "./generalSettings";

export type CompletionSoundOption = {
  value: CompletionSound;
  label: string;
};

type PlayableCompletionSound = Exclude<CompletionSound, "off">;

const SOUND_URLS: Record<PlayableCompletionSound, string> = {
  chime: "/sounds/chime.mp3",
  ding: "/sounds/ding.mp3",
  pop: "/sounds/pop.mp3",
};

export const COMPLETION_SOUND_OPTIONS: readonly CompletionSoundOption[] = [
  { value: "off", label: "Off" },
  { value: "chime", label: "Chime" },
  { value: "ding", label: "Ding" },
  { value: "pop", label: "Pop" },
];

const audioBufferCache = new Map<PlayableCompletionSound, Promise<AudioBuffer | null>>();
const activePlaybackCache = new Map<PlayableCompletionSound, AudioBufferSourceNode>();
let sharedAudioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") {
    return null;
  }

  if (sharedAudioContext) {
    return sharedAudioContext;
  }

  const AudioContextCtor = window.AudioContext
    ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    return null;
  }

  sharedAudioContext = new AudioContextCtor();
  return sharedAudioContext;
}

function cleanupPlayback(sound: PlayableCompletionSound, source: AudioBufferSourceNode, gainNode: GainNode): void {
  if (activePlaybackCache.get(sound) === source) {
    activePlaybackCache.delete(sound);
  }

  try {
    source.disconnect();
  } catch {
    // Ignore disconnect failures during cleanup.
  }

  try {
    gainNode.disconnect();
  } catch {
    // Ignore disconnect failures during cleanup.
  }
}

function stopCompletionSound(sound: PlayableCompletionSound): void {
  const activePlayback = activePlaybackCache.get(sound);
  if (!activePlayback) {
    return;
  }

  activePlaybackCache.delete(sound);

  try {
    activePlayback.stop();
  } catch {
    // Ignore stop failures when the source already ended.
  }
}

async function loadAudioBuffer(sound: PlayableCompletionSound, audioContext: AudioContext): Promise<AudioBuffer | null> {
  const existing = audioBufferCache.get(sound);
  if (existing) {
    return existing;
  }

  const nextBufferPromise = fetch(SOUND_URLS[sound])
    .then(async (response) => {
      if (!response.ok) {
        return null;
      }

      const audioData = await response.arrayBuffer();
      return audioContext.decodeAudioData(audioData);
    })
    .catch(() => null);

  audioBufferCache.set(sound, nextBufferPromise);
  return nextBufferPromise;
}

export async function playCompletionSound(
  sound: CompletionSound,
  volume = DEFAULT_COMPLETION_SOUND_VOLUME,
): Promise<boolean> {
  if (sound === "off") {
    return false;
  }

  const audioContext = getAudioContext();
  if (!audioContext) {
    return false;
  }

  try {
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
  } catch {
    // Ignore resume failures and attempt playback anyway.
  }

  const buffer = await loadAudioBuffer(sound, audioContext);
  if (!buffer) {
    return false;
  }

  try {
    stopCompletionSound(sound);

    const source = audioContext.createBufferSource();
    source.buffer = buffer;

    const gainNode = audioContext.createGain();
    gainNode.gain.value = Math.max(0, volume) / 100;

    source.connect(gainNode);
    gainNode.connect(audioContext.destination);
    source.onended = () => {
      cleanupPlayback(sound, source, gainNode);
    };

    activePlaybackCache.set(sound, source);
    source.start(0);
    return true;
  } catch {
    return false;
  }
}

export function stopCompletionSoundPlayback(): void {
  for (const sound of activePlaybackCache.keys()) {
    stopCompletionSound(sound);
  }
}
