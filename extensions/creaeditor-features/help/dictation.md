# Dictation

Talk instead of type. Dictation turns what you say into text in the chat input box, in the editor window and in the Agents window. CreaEditor dictates with **Whisper Large** (OpenAI's Whisper Large v3 Turbo speech model), which runs on your own computer: your audio never leaves it.

## How it works

- **The model runs on this computer.** Whisper runs through Microsoft's Foundry Local runtime, which comes with CreaEditor. The model itself (about 1.3 GB) is not in the app: it is downloaded once, the first time you dictate, and only after you agree to it.
- **Text appears per sentence.** Whisper listens until you pause, then writes what you said. While it works on a sentence, the words appear in the input box one by one; you can keep talking meanwhile. When you stop dictation, the last sentence is written too.
- **Dutch and English mixed.** Whisper keeps English words in English inside, for example, a Dutch sentence ("Kun je de functie parseConfigFile aanpassen?"). It needs to know which language you speak besides English (see below). Pause briefly when you switch language between sentences: Whisper writes one language per sentence and can skip a whole sentence in the other language when there is no pause between them.

## Using it

### The first time: install Whisper

1. Click the microphone button in the chat input box (or use the dictation shortcut, **Cmd+I**).
2. CreaEditor asks **Install the Whisper Large Speech Model?** It needs about 1.3 GB, downloaded once from Microsoft's Foundry Local catalog.
3. Click **Download**. The download runs in the background, with its progress (and a cancel button) in a notification. Dictation does not start yet. Click **Cancel** and nothing is downloaded.
4. When the download is done, CreaEditor says **Whisper is installed. Start dictation again to talk.** Click the microphone again.

The first time you dictate, macOS asks whether CreaEditor may use the microphone. Click **Allow**. Changed your mind? Turn it on again in **System Settings > Privacy & Security > Microphone**.

### Dictate

1. Click the microphone button and talk.
2. A slim **listening bar** shows directly above the input box while dictation listens: a live graph of your microphone level, and **Listening…** or, while Whisper writes a sentence, **Transcribing…**. When your system is set to reduce motion, the graph is a still level meter instead.
3. Click the microphone again to stop. In the editor window's chat, **Escape** cancels and throws away what was said.

### Choose your language

Whisper writes in the language it is told; told nothing, it writes English and translates other languages into English. The setting **Dictation: Language** (`dictation.language`) picks the language:

- **Automatic** (the default) uses the Voice Mode language when you set one, otherwise the first language other than English in the display language and in your system's preferred languages (macOS: **System Settings > General > Language & Region**). With English and Dutch there, it uses Dutch.
- When you mix English with another language, choose the other language, for example **Dutch**. English sentences stay English.
- Choose **English** only when you speak English alone.

## Good to know

- Whisper uses the processor for a few seconds per sentence. On a busy computer the text can lag a little behind; it catches up when you pause.
- The other dictation models are still in **Dictation: Model** (`dictation.model`): Nemotron (on-device, streams word by word, less accurate) and MAI (cloud, needs a GitHub account).
- Remove the model: delete the folder `chatDictationModels` in CreaEditor's cache folder (`~/Library/Application Support/CreaEditor/chatDictationModels` on macOS). CreaEditor asks again before downloading it the next time.
