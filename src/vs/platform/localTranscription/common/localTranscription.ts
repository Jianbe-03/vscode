/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const ILocalTranscriptionService = createDecorator<ILocalTranscriptionService>('localTranscriptionService');

/** IPC channel name used to reach the transcription service in the utility process. */
export const localTranscriptionChannelName = 'localTranscription';

/**
 * Default on-device model used for dictation. CreaEditor: Whisper Large v3 Turbo (Foundry Local alias),
 * which is far more accurate than the streaming Nemotron model and keeps English words in English
 * inside, for example, Dutch speech.
 */
export const DEFAULT_LOCAL_TRANSCRIPTION_MODEL = 'whisper-large-v3-turbo';

/**
 * CreaEditor: Whisper Small (Foundry Local alias), the faster alternative to {@link DEFAULT_LOCAL_TRANSCRIPTION_MODEL}:
 * about a third of its size and several times quicker, a little less accurate.
 */
export const SMALL_LOCAL_TRANSCRIPTION_MODEL = 'whisper-small';

/** CreaEditor: the streaming Nemotron model upstream VS Code uses; still selectable in `dictation.model`. */
export const NEMOTRON_LOCAL_TRANSCRIPTION_MODEL = 'nemotron-3.5-asr-streaming-0.6b';

/**
 * CreaEditor: whether `model` cannot stream (Whisper). Foundry Local's live transcription session
 * only runs Nemotron models ("NemotronStreamingProcessor requires a nemotron_speech model type"), so
 * these models dictate in segments: the audio is cut at pauses and each utterance is transcribed whole.
 */
export function isSegmentedTranscriptionModel(model: string | undefined): boolean {
	return /whisper/i.test(model ?? DEFAULT_LOCAL_TRANSCRIPTION_MODEL);
}

/**
 * CreaEditor: options that locate the model cache and the native runtime, and bridge VS Code's proxy
 * settings into the utility process (see {@link ILocalTranscriptionService.start}).
 */
export interface ILocalTranscriptionModelOptions {
	readonly cacheDir: string;
	readonly model?: string;
	readonly proxyUrl?: string;
	readonly noProxy?: string;
	readonly proxyStrictSSL?: boolean;
	readonly proxyAuthorization?: string;
	readonly runtimeUrlTemplate?: string;
	readonly runtimeVersion?: string;
}

/** CreaEditor: whether a model is on disk, and how big its download is. */
export interface ILocalTranscriptionModelInstallState {
	readonly installed: boolean;
	/** Download size in MB, from the Foundry Local catalog (when it could be read). */
	readonly sizeMb?: number;
}

/**
 * CreaEditor: `errorCode` of the model status when dictation started with a model that is not on
 * disk. `start` never downloads a model; only {@link ILocalTranscriptionService.downloadModel} does,
 * after the user agreed to the download.
 */
export const MODEL_NOT_INSTALLED_ERROR_CODE = 'notInstalled';

export interface ILocalTranscriptionModelImportResult {
	readonly model: string;
	readonly version: number;
}

/** Lifecycle of the downloaded transcription model. */
export const enum LocalTranscriptionModelState {
	/** Model has not been requested yet. */
	Idle = 'idle',
	/** Model files are being downloaded to the on-disk cache. */
	Downloading = 'downloading',
	/** Model is being loaded into memory. */
	Loading = 'loading',
	/** Model is loaded and ready to transcribe. */
	Ready = 'ready',
	/** Model failed to download or load. */
	Error = 'error',
}

export interface ILocalTranscriptionModelStatus {
	readonly state: LocalTranscriptionModelState;
	/** Overall download progress in [0, 1] while `Downloading`. */
	readonly progress?: number;
	/**
	 * Whether model files were actually fetched from the network (a cache miss)
	 * during this preparation, as opposed to loaded from the on-disk cache. Set
	 * on the `Ready` status. Used for download telemetry.
	 */
	readonly downloaded?: boolean;
	/** Human-readable error message when `state === Error` (for UI/logging). */
	readonly error?: string;
	/**
	 * Allowlisted, low-cardinality error identifier when `state === Error`
	 * (e.g. `network`, `notFound`, `memory`), safe to send as telemetry.
	 */
	readonly errorCode?: string;
}

export interface ILocalTranscriptionResult {
	/** Cumulative transcript for the active session. */
	readonly text: string;
	/** True for the final result emitted after `stop`. */
	readonly isFinal: boolean;
	/**
	 * The leading portion of `text` that Foundry has already finalized (its
	 * endpointed segments). The remainder of `text` is the still-in-progress
	 * interim tail. Lets the renderer stop shimmering finalized text as soon as
	 * a segment is endpointed — including the last one during a trailing silence
	 * — instead of waiting for a later interim to confirm it stopped changing.
	 */
	readonly finalizedText?: string;
	/**
	 * CreaEditor: segmented models (Whisper) only. Utterances that ended and are still being
	 * transcribed; the renderer shows "Transcribing…" while this is above zero.
	 */
	readonly pendingSegments?: number;
}


/**
 * On-device speech-to-text using a downloaded model. Transcription runs through
 * Microsoft's Foundry Local streaming ASR engine (onnxruntime + onnxruntime-genai
 * native runtime). Streaming models (NVIDIA's Nemotron 3.5 RNN-T) do their own
 * VAD and endpointing; CreaEditor's default, Whisper Large v3 Turbo, cannot
 * stream, so the service cuts the audio at pauses and transcribes each utterance
 * (see `SpeechSegmenter`). The model is chosen by the `dictation.model` setting. Runs in a utility process. A
 * single transcription session is active at a time (dictation is a singleton
 * in the renderer).
 *
 * The renderer streams PCM16 mono 16 kHz audio via `pushAudio`; the service
 * emits interim transcripts on `onDidTranscribe` and a final one after `stop`.
 */
export interface ILocalTranscriptionService {
	readonly _serviceBrand: undefined;

	/**
	 * Whether on-device transcription can run in this environment. False on web
	 * (no utility process) and on desktop platforms/architectures without a
	 * Foundry Local native runtime. When false, dictation is unavailable — there
	 * is no cloud fallback.
	 */
	readonly isSupported: boolean;

	/** Fires as the model downloads/loads so the UI can show progress. */
	readonly onDidChangeModelStatus: Event<ILocalTranscriptionModelStatus>;

	/** Fires with interim (and, after stop, final) transcripts. */
	readonly onDidTranscribe: Event<ILocalTranscriptionResult>;

	/** Current model status (e.g. to gate the dictation UI). */
	getModelStatus(): Promise<ILocalTranscriptionModelStatus>;

	/**
	 * Imports the default on-device model from an official Foundry Local expansion
	 * pack or a prepared model directory into `cacheDir`.
	 */
	importModel(options: { readonly sourcePath: string; readonly cacheDir: string }): Promise<ILocalTranscriptionModelImportResult>;

	/** CreaEditor: whether the model is on disk (no download, and no prompt needed before dictating). */
	getModelInstallState(options: ILocalTranscriptionModelOptions): Promise<ILocalTranscriptionModelInstallState>;

	/**
	 * CreaEditor: download (and load) the model. Only called after the user agreed to the download;
	 * progress is reported on {@link onDidChangeModelStatus}, and {@link cancel} stops it.
	 */
	downloadModel(options: ILocalTranscriptionModelOptions): Promise<void>;

	/**
	 * CreaEditor: the languages the user set up in the operating system, most preferred first (on
	 * macOS the full "Preferred Languages" list, which the renderer's `navigator.languages` does not
	 * show). Whisper's automatic language hint picks the first one that is not English.
	 */
	getSystemLanguages(): Promise<string[]>;

	/**
	 * Ensure the model is loaded (idempotent) and begin a new transcription
	 * session. CreaEditor: never downloads; a model that is not on disk fails
	 * with {@link MODEL_NOT_INSTALLED_ERROR_CODE}. `cacheDir` is where model files are stored. `model`
	 * selects the on-device Foundry Local model; when omitted the service default
	 * is used. `language` optionally hints the spoken language.
	 *
	 * `proxyUrl`/`noProxy` bridge VS Code's `http.proxy`/`http.noProxy` settings
	 * into this utility process: when set, they are applied as the standard proxy
	 * environment variables before any download, so all provisioning legs — the
	 * addon tarball and NuGet core libraries (our own fetches) and the native
	 * Foundry Local *model* download — route through the proxy. When they are
	 * omitted, the process's inherited OS environment proxy vars still apply.
	 *
	 * `proxyStrictSSL === false` (VS Code's `http.proxyStrictSSL`) disables TLS
	 * certificate verification for the JavaScript download legs. `proxyAuthorization`
	 * (VS Code's `http.proxyAuthorization`, a `Basic <base64>` value) is folded into
	 * the proxy URL's credentials so both our fetches and the native model download
	 * authenticate to the proxy. TLS-intercepting proxies otherwise rely on the CA
	 * being in the OS trust store (matching `@vscode/proxy-agent` and the desktop
	 * app).
	 *
	 * `runtimeUrlTemplate`/`runtimeVersion` come from `product.dictationRuntime`
	 * (stamped by `build/dictation-runtime/produce.ts`). When set, the native
	 * runtime (Foundry Local addon + core libraries) is downloaded from VS Code's
	 * CDN for this host's target. When omitted (local dev builds), the runtime
	 * falls back to the SDK's own `node_modules` payload and nothing is downloaded.
	 */
	start(options: ILocalTranscriptionModelOptions & { readonly language?: string }): Promise<void>;

	/** Append captured audio (raw little-endian PCM16 mono 16 kHz). */
	pushAudio(chunk: VSBuffer): Promise<void>;

	/** Finish the session; resolves with the final transcript. */
	stop(): Promise<string>;

	/** Abort the session, discarding the transcript. */
	cancel(): Promise<void>;
}
