/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Language } from '../../../../../base/common/platform.js';

const NEMOTRON_LOCALES = new Set([
	'ar-AR', 'bg-BG', 'cs-CZ', 'da-DK', 'de-DE', 'en-GB', 'en-US', 'es-ES',
	'es-US', 'et-EE', 'fi-FI', 'fr-CA', 'fr-FR', 'el-GR', 'he-IL', 'hi-IN',
	'hr-HR', 'hu-HU', 'it-IT', 'ja-JP', 'ko-KR', 'lt-LT', 'lv-LV', 'mt-MT',
	'nb-NO', 'nl-NL', 'nn-NO', 'pl-PL', 'pt-BR', 'pt-PT', 'ro-RO', 'ru-RU',
	'sk-SK', 'sl-SI', 'sv-SE', 'th-TH', 'tr-TR', 'uk-UA', 'vi-VN', 'zh-CN',
]);

const NEMOTRON_DEFAULT_LOCALE_BY_LANGUAGE: Readonly<Record<string, string>> = {
	ar: 'ar-AR',
	bg: 'bg-BG',
	cs: 'cs-CZ',
	da: 'da-DK',
	de: 'de-DE',
	en: 'en-US',
	es: 'es-US',
	et: 'et-EE',
	el: 'el-GR',
	fi: 'fi-FI',
	fr: 'fr-FR',
	he: 'he-IL',
	hi: 'hi-IN',
	hr: 'hr-HR',
	hu: 'hu-HU',
	it: 'it-IT',
	ja: 'ja-JP',
	ko: 'ko-KR',
	lt: 'lt-LT',
	lv: 'lv-LV',
	mt: 'mt-MT',
	nb: 'nb-NO',
	nl: 'nl-NL',
	nn: 'nn-NO',
	pl: 'pl-PL',
	pt: 'pt-PT',
	ro: 'ro-RO',
	ru: 'ru-RU',
	sk: 'sk-SK',
	sl: 'sl-SI',
	sv: 'sv-SE',
	th: 'th-TH',
	tr: 'tr-TR',
	uk: 'uk-UA',
	vi: 'vi-VN',
	zh: 'zh-CN',
};

function getConfiguredDisplayLanguage(): string | undefined {
	return Language.value();
}

/**
 * Resolve the on-device dictation language using the same setting semantics as
 * Voice Mode. Automatic follows the configured display language when supported,
 * then the system or browser locale, then the model's language detection.
 */
export function resolveDictationLanguage(configuredLanguage: unknown, browserLanguage: string | undefined, displayLanguage = getConfiguredDisplayLanguage()): string {
	const configured = typeof configuredLanguage === 'string' ? configuredLanguage.trim() : '';
	if (configured && configured.toLowerCase() !== 'auto') {
		return resolveSupportedDictationLanguage(configured) ?? 'auto';
	}

	return resolveSupportedDictationLanguage(displayLanguage)
		?? resolveSupportedDictationLanguage(browserLanguage)
		?? 'auto';
}

function resolveSupportedDictationLanguage(candidate: string | undefined): string | undefined {
	if (!candidate || typeof Intl.getCanonicalLocales !== 'function') {
		return undefined;
	}

	try {
		const canonical = Intl.getCanonicalLocales(candidate)[0];
		if (NEMOTRON_LOCALES.has(canonical)) {
			return canonical;
		}
		return NEMOTRON_DEFAULT_LOCALE_BY_LANGUAGE[canonical.split('-')[0]];
	} catch {
		return undefined;
	}
}

/** CreaEditor: the ISO 639-1 base of a language tag (`nl-NL` → `nl`), or `undefined` for none or `auto`. */
function toBaseLanguage(candidate: unknown): string | undefined {
	if (typeof candidate !== 'string') {
		return undefined;
	}
	const base = candidate.trim().toLowerCase().split(/[-_]/)[0];
	return base && base !== 'auto' && /^[a-z]{2,3}$/.test(base) ? base : undefined;
}

/**
 * CreaEditor: the language hint for Whisper dictation. Foundry Local's Whisper does not detect the
 * language: without a hint (or with English) it writes English, translating other speech. With a
 * hint for another language it still keeps English words and sentences in English, so for people
 * who mix English with another language the other language is the right hint.
 *
 * In order: `dictation.language`, then the Voice Mode language, then the first language other than
 * English among the display language and the system/browser languages, and English when there is none.
 */
export function resolveWhisperDictationLanguage(dictationLanguage: unknown, voiceLanguage: unknown, systemLanguages: readonly string[], displayLanguage = getConfiguredDisplayLanguage()): string {
	const explicit = toBaseLanguage(dictationLanguage) ?? toBaseLanguage(voiceLanguage);
	if (explicit) {
		return explicit;
	}
	for (const candidate of [displayLanguage, ...systemLanguages]) {
		const base = toBaseLanguage(candidate);
		if (base && base !== 'en') {
			return base;
		}
	}
	return 'en';
}
