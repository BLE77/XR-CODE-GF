/// <reference types="vite/client" />

interface Window {
  SpeechRecognition?: new () => {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    start: () => void;
    stop: () => void;
    onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
    onerror: ((event: { error: string }) => void) | null;
    onend: (() => void) | null;
  };
  webkitSpeechRecognition?: Window["SpeechRecognition"];
}
