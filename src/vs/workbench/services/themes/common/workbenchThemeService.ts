/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { refineServiceDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { Color } from '../../../../base/common/color.js';
import { IColorTheme, IThemeService, IFileIconTheme, IProductIconTheme } from '../../../../platform/theme/common/themeService.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { isBoolean, isString } from '../../../../base/common/types.js';
import { IconContribution, IconDefinition } from '../../../../platform/theme/common/iconRegistry.js';
import { ColorScheme, ThemeTypeSelector } from '../../../../platform/theme/common/theme.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';

export const IWorkbenchThemeService = refineServiceDecorator<IThemeService, IWorkbenchThemeService>(IThemeService);

export const THEME_SCOPE_OPEN_PAREN = '[';
export const THEME_SCOPE_CLOSE_PAREN = ']';
export const THEME_SCOPE_WILDCARD = '*';

export const themeScopeRegex = /\[(.+?)\]/g;

export enum ThemeSettings {
	COLOR_THEME = 'workbench.colorTheme',
	FILE_ICON_THEME = 'workbench.iconTheme',
	PRODUCT_ICON_THEME = 'workbench.productIconTheme',
	COLOR_CUSTOMIZATIONS = 'workbench.colorCustomizations',
	TOKEN_COLOR_CUSTOMIZATIONS = 'editor.tokenColorCustomizations',
	SEMANTIC_TOKEN_COLOR_CUSTOMIZATIONS = 'editor.semanticTokenColorCustomizations',

	PREFERRED_DARK_THEME = 'workbench.preferredDarkColorTheme',
	PREFERRED_LIGHT_THEME = 'workbench.preferredLightColorTheme',
	PREFERRED_HC_DARK_THEME = 'workbench.preferredHighContrastColorTheme', /* id kept for compatibility reasons */
	PREFERRED_HC_LIGHT_THEME = 'workbench.preferredHighContrastLightColorTheme',
	DETECT_COLOR_SCHEME = 'window.autoDetectColorScheme',
	DETECT_HC = 'window.autoDetectHighContrast',

	SYSTEM_COLOR_THEME = 'window.systemColorTheme'
}

export namespace ThemeSettingDefaults {
	export const COLOR_THEME_DARK = 'Creacoon Dark'; // CreaEditor
	export const COLOR_THEME_LIGHT = 'Creacoon Light'; // CreaEditor
	export const COLOR_THEME_HC_DARK = 'Default High Contrast';
	export const COLOR_THEME_HC_LIGHT = 'Default High Contrast Light';

	export const FILE_ICON_THEME = 'vs-seti';
	export const PRODUCT_ICON_THEME = 'Default';
}

/**
 * Migrates legacy theme settings IDs to their current equivalents.
 * Theme IDs were simplified: "Default" prefix was removed from built-in themes,
 * and "Experimental" prefix was replaced when VS Code themes became GA.
 */
export function migrateThemeSettingsId(settingsId: string): string {
	switch (settingsId) {
		case 'Default Dark Modern': return 'Dark Modern';
		case 'Default Light Modern': return 'Light Modern';
		case 'Default Dark+': return 'Dark+';
		case 'Default Light+': return 'Light+';
		case 'Experimental Dark':
		case 'VS Code Dark':
			return ThemeSettingDefaults.COLOR_THEME_DARK;
		case 'Experimental Light':
		case 'VS Code Light':
			return ThemeSettingDefaults.COLOR_THEME_LIGHT;
	}
	return settingsId;
}

export const COLOR_THEME_DARK_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#383a49',
	'activityBar.activeBorder': '#00EC95',
	'activityBar.background': '#1C1A37',
	'activityBar.border': '#29274B',
	'activityBar.foreground': '#BFBFCE',
	'activityBar.inactiveForeground': '#8684A2',
	'activityBarBadge.background': '#00EC95',
	'activityBarBadge.foreground': '#1B1A36',
	'badge.background': '#00EC95',
	'badge.foreground': '#1B1A36',
	'button.background': '#00BD8B',
	'button.border': '#00BD8B',
	'button.foreground': '#1B1A36',
	'button.hoverBackground': '#00D69C',
	'button.secondaryBackground': '#2E2C51',
	'button.secondaryForeground': '#C9C8D6',
	'button.secondaryHoverBackground': '#FFFFFF10',
	'chat.slashCommandBackground': '#26477866',
	'chat.slashCommandForeground': '#0AFFAD',
	'chat.editedFileForeground': '#E2C08D',
	'checkbox.background': '#232145',
	'checkbox.border': '#69678B',
	'debugToolBar.background': '#1A1934',
	'descriptionForeground': '#8684A2',
	'dropdown.background': '#1C1A37',
	'dropdown.border': '#323054',
	'dropdown.foreground': '#BFBFCE',
	'dropdown.listBackground': '#1C1A37',
	'editor.background': '#16152D',
	'editor.findMatchBackground': '#00A87090',
	'editor.foreground': '#BAB9C9',
	'editor.inactiveSelectionBackground': '#00A87060',
	'editor.selectionHighlightBackground': '#00A87060',
	'editorGroup.border': '#FFFFFF17',
	'editorGroupHeader.tabsBackground': '#1C1A37',
	'editorGroupHeader.tabsBorder': '#29274B',
	'editorGutter.addedBackground': '#72C892',
	'editorGutter.deletedBackground': '#F28772',
	'editorGutter.modifiedBackground': '#00C986',
	'editorIndentGuide.activeBackground1': '#7D7B9C',
	'editorIndentGuide.background1': '#7D7B9C4D',
	'editorLineNumber.activeForeground': '#BAB9C9',
	'editorLineNumber.foreground': '#807E9E',
	'editorOverviewRuler.border': '#29274B',
	'editorWidget.background': '#201F40',
	'errorForeground': '#f48771',
	'focusBorder': '#00EC95B3',
	'foreground': '#BFBFCE',
	'icon.foreground': '#8684A2',
	'input.background': '#1C1A37',
	'input.border': '#323054',
	'input.foreground': '#BFBFCE',
	'input.placeholderForeground': '#52516F',
	'inputOption.activeBackground': '#2F2D52',
	'inputOption.activeBorder': '#29274B',
	'keybindingLabel.foreground': '#C9C8D6',
	'list.activeSelectionIconForeground': '#FFF',
	'list.dropBackground': '#00E99B1A',
	'menu.background': '#201F40',
	'menu.border': '#29274B',
	'menu.foreground': '#BFBFCE',
	'menu.selectionBackground': '#00E99B26',
	'menu.separatorBackground': '#29274B',
	'notificationCenterHeader.background': '#232145',
	'notificationCenterHeader.foreground': '#BFBFCE',
	'notifications.background': '#201F40',
	'notifications.border': '#29274B',
	'notifications.foreground': '#BFBFCE',
	'panel.background': '#1C1A37',
	'panel.border': '#29274B',
	'panelInput.border': '#29274B',
	'panelTitle.activeBorder': '#00EC95',
	'panelTitle.activeForeground': '#BFBFCE',
	'panelTitle.inactiveForeground': '#8684A2',
	'peekViewEditor.background': '#1C1A37',
	'peekViewEditor.matchHighlightBackground': '#00E99B33',
	'peekViewResult.background': '#1C1A37',
	'peekViewResult.matchHighlightBackground': '#00E99B33',
	'pickerGroup.border': '#29274B',
	'ports.iconRunningProcessForeground': '#369432',
	'progressBar.background': '#00EC95',
	'quickInput.background': '#201F40',
	'quickInput.foreground': '#BFBFCE',
	'settings.dropdownBackground': '#2E2C51',
	'settings.dropdownBorder': '#39375B',
	'settings.headerForeground': '#FFFFFF',
	'settings.modifiedItemIndicator': '#BB800966',
	'sideBar.background': '#1C1A37',
	'sideBar.border': '#29274B',
	'sideBar.foreground': '#BFBFCE',
	'sideBarSectionHeader.background': '#1C1A37',
	'sideBarSectionHeader.border': '#29274B',
	'sideBarSectionHeader.foreground': '#BFBFCE',
	'sideBarTitle.foreground': '#BFBFCE',
	'statusBar.background': '#1C1A37',
	'statusBar.border': '#29274B',
	'statusBar.debuggingBackground': '#00E99B',
	'statusBar.debuggingForeground': '#FFFFFF',
	'statusBar.focusBorder': '#00E99BB3',
	'statusBar.foreground': '#8684A2',
	'statusBar.noFolderBackground': '#1C1A37',
	'statusBarItem.focusBorder': '#00E99BB3',
	'statusBarItem.prominentBackground': '#00E99B',
	'statusBarItem.remoteBackground': '#00BD8B',
	'statusBarItem.remoteForeground': '#1B1A36',
	'tab.activeBackground': '#17162D',
	'tab.activeBorder': '#17162D',
	'tab.activeBorderTop': '#00EC95',
	'tab.activeForeground': '#BFBFCE',
	'tab.border': '#29274B',
	'tab.hoverBackground': '#17162D',
	'tab.inactiveBackground': '#1C1A37',
	'tab.inactiveForeground': '#8684A2',
	'tab.lastPinnedBorder': '#29274B',
	'tab.selectedBackground': '#373559',
	'tab.selectedBorderTop': '#0AFFAD',
	'tab.selectedForeground': '#FFFFFF',
	'tab.unfocusedActiveBorder': '#1F1D3D',
	'tab.unfocusedActiveBorderTop': '#29274B',
	'tab.unfocusedHoverBackground': '#1F1D3D',
	'terminal.foreground': '#C9C8D6',
	'terminal.inactiveSelectionBackground': '#3B395C',
	'terminal.tab.activeBorder': '#00E99B00',
	'textBlockQuote.background': '#232145',
	'textBlockQuote.border': '#00BD8B',
	'textCodeBlock.background': '#232145',
	'textLink.activeForeground': '#4DF3B5',
	'textLink.foreground': '#00EC95',
	'textPreformat.background': '#242246',
	'textPreformat.foreground': '#8684A2',
	'textSeparator.foreground': '#28264A',
	'titleBar.activeBackground': '#1C1A37',
	'titleBar.activeForeground': '#8684A2',
	'titleBar.border': '#29274B',
	'titleBar.inactiveBackground': '#17162D',
	'titleBar.inactiveForeground': '#8684A2',
	'welcomePage.progress.foreground': '#00C986',
	'welcomePage.tileBackground': '#29274B',
	'widget.border': '#29274B'
};

export const COLOR_THEME_LIGHT_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#DBDAE5',
	'activityBar.activeBorder': '#00BD8B',
	'activityBar.background': '#F9F9FB',
	'activityBar.border': '#EFEEF4',
	'activityBar.foreground': '#1C1A36',
	'activityBar.inactiveForeground': '#575675',
	'activityBarBadge.background': '#00BD8B',
	'activityBarBadge.foreground': '#1B1A36',
	'badge.background': '#00BD8B',
	'badge.foreground': '#1B1A36',
	'button.background': '#00BD8B',
	'button.border': '#00BD8B',
	'button.foreground': '#1B1A36',
	'button.hoverBackground': '#00D69C',
	'button.secondaryBackground': '#EAEAF1',
	'button.secondaryForeground': '#1C1A36',
	'button.secondaryHoverBackground': '#F0F0F6',
	'chat.slashCommandBackground': '#ADCEFF7A',
	'chat.slashCommandForeground': '#007F55',
	'chat.editedFileForeground': '#895503',
	'checkbox.background': '#EAEAF1',
	'checkbox.border': '#7C7A9B',
	'descriptionForeground': '#575675',
	'diffEditor.unchangedRegionBackground': '#F5F5F9',
	'dropdown.background': '#FFFFFF',
	'dropdown.border': '#D8D8E4',
	'dropdown.foreground': '#1C1A36',
	'dropdown.listBackground': '#FFFFFF',
	'editor.background': '#FFFFFF',
	'editor.foreground': '#1C1A36',
	'editor.inactiveSelectionBackground': '#0085581A',
	'editor.selectionHighlightBackground': '#00855815',
	'editorGroup.border': '#E3E3EC',
	'editorGroupHeader.tabsBackground': '#F9F9FB',
	'editorGroupHeader.tabsBorder': '#EFEEF4',
	'editorGutter.addedBackground': '#587c0c',
	'editorGutter.deletedBackground': '#ad0707',
	'editorGutter.modifiedBackground': '#007850',
	'editorIndentGuide.activeBackground1': '#ECECF3',
	'editorIndentGuide.background1': '#F4F4F840',
	'editorLineNumber.activeForeground': '#1C1A36',
	'editorLineNumber.foreground': '#575675',
	'editorOverviewRuler.border': '#EFEEF4',
	'editorSuggestWidget.background': '#F9F9FB',
	'editorWidget.background': '#F9F9FB',
	'errorForeground': '#ad0707',
	'focusBorder': '#00BD8B',
	'foreground': '#1C1A36',
	'icon.foreground': '#575675',
	'input.background': '#FFFFFF',
	'input.border': '#D5D5E166',
	'input.foreground': '#1C1A36',
	'input.placeholderForeground': '#9190AA',
	'inputOption.activeBackground': '#D6D5E2',
	'inputOption.activeBorder': '#EFEEF4',
	'inputOption.activeForeground': '#1C1A36',
	'keybindingLabel.foreground': '#323054',
	'list.activeSelectionBackground': '#00000025',
	'list.activeSelectionForeground': '#1C1A36',
	'list.activeSelectionIconForeground': '#000000',
	'list.focusAndSelectionOutline': '#007850',
	'list.hoverBackground': '#00000014',
	'menu.border': '#E6E5EE',
	'menu.selectionBackground': '#0085581A',
	'menu.selectionForeground': '#1C1A36',
	'notebook.cellBorderColor': '#E3E3EC',
	'notebook.selectedCellBackground': '#C8DDF150',
	'notificationCenterHeader.background': '#F9F9FB',
	'notificationCenterHeader.foreground': '#1C1A36',
	'notifications.background': '#F9F9FB',
	'notifications.border': '#EFEEF4',
	'notifications.foreground': '#1C1A36',
	'panel.background': '#F9F9FB',
	'panel.border': '#EFEEF4',
	'panelInput.border': '#E3E3EC',
	'panelTitle.activeBorder': '#00BD8B',
	'panelTitle.activeForeground': '#1C1A36',
	'panelTitle.inactiveForeground': '#575675',
	'peekViewEditor.matchHighlightBackground': '#00855833',
	'peekViewResult.background': '#F9F9FB',
	'peekViewResult.matchHighlightBackground': '#00855833',
	'pickerGroup.border': '#EEEDF4',
	'pickerGroup.foreground': '#1C1A36',
	'ports.iconRunningProcessForeground': '#369432',
	'progressBar.background': '#00BD8B',
	'quickInput.background': '#F9F9FB',
	'quickInput.foreground': '#1C1A36',
	'searchEditor.textInputBorder': '#CBCAD8',
	'settings.dropdownBackground': '#FFFFFF',
	'settings.dropdownBorder': '#CBCAD8',
	'settings.headerForeground': '#1B1A35',
	'settings.modifiedItemIndicator': '#BB800966',
	'settings.numberInputBorder': '#CBCAD8',
	'settings.textInputBorder': '#CBCAD8',
	'sideBar.background': '#F9F9FB',
	'sideBar.border': '#EFEEF4',
	'sideBar.foreground': '#1C1A36',
	'sideBarSectionHeader.background': '#F9F9FB',
	'sideBarSectionHeader.border': '#EFEEF4',
	'sideBarSectionHeader.foreground': '#1C1A36',
	'sideBarTitle.foreground': '#1C1A36',
	'statusBar.background': '#F9F9FB',
	'statusBar.border': '#EFEEF4',
	'statusBar.debuggingBackground': '#008558',
	'statusBar.debuggingForeground': '#FFFFFF',
	'statusBar.focusBorder': '#008558',
	'statusBar.foreground': '#575675',
	'statusBar.noFolderBackground': '#EFEFF5',
	'statusBarItem.compactHoverBackground': '#C9C8D6',
	'statusBarItem.errorBackground': '#C72E0F',
	'statusBarItem.focusBorder': '#008558',
	'statusBarItem.hoverBackground': '#E5E4ED',
	'statusBarItem.prominentBackground': '#008558DD',
	'statusBarItem.remoteBackground': '#00BD8B',
	'statusBarItem.remoteForeground': '#1B1A36',
	'tab.activeBackground': '#FFFFFF',
	'tab.activeBorder': '#FFFFFF',
	'tab.activeBorderTop': '#00BD8B',
	'tab.activeForeground': '#1C1A36',
	'tab.border': '#EFEEF4',
	'tab.hoverBackground': '#FFFFFF',
	'tab.inactiveBackground': '#F9F9FB',
	'tab.inactiveForeground': '#575675',
	'tab.lastPinnedBorder': '#EFEEF4',
	'tab.selectedBackground': '#E9E8F0',
	'tab.selectedBorderTop': '#009966',
	'tab.selectedForeground': '#2A284D',
	'tab.unfocusedActiveBorder': '#F5F5F9',
	'tab.unfocusedActiveBorderTop': '#E3E3EC',
	'tab.unfocusedHoverBackground': '#F5F5F9',
	'terminal.foreground': '#323054',
	'terminal.inactiveSelectionBackground': '#E9E9F0',
	'terminal.tab.activeBorder': '#007850',
	'terminalCursor.foreground': '#1C1A36',
	'textBlockQuote.background': '#EAEAF1',
	'textBlockQuote.border': '#00BD8B',
	'textCodeBlock.background': '#EAEAF1',
	'textLink.activeForeground': '#00664C',
	'textLink.foreground': '#00805F',
	'textPreformat.background': '#EBEBF2',
	'textPreformat.foreground': '#575675',
	'textSeparator.foreground': '#ECECF3',
	'titleBar.activeBackground': '#F9F9FB',
	'titleBar.activeForeground': '#575675',
	'titleBar.border': '#EFEEF4',
	'titleBar.inactiveBackground': '#F9F9FB',
	'titleBar.inactiveForeground': '#575675',
	'welcomePage.tileBackground': '#F0F0F6',
	'widget.border': '#E4E4ED'
};

export interface IWorkbenchTheme {
	readonly id: string;
	readonly label: string;
	readonly extensionData?: ExtensionData;
	readonly description?: string;
	readonly settingsId: string | null;
}

export interface IWorkbenchColorTheme extends IWorkbenchTheme, IColorTheme {
	readonly settingsId: string;
	readonly tokenColors: ITextMateThemingRule[];
}

export interface IColorMap {
	[id: string]: Color;
}

export interface IWorkbenchFileIconTheme extends IWorkbenchTheme, IFileIconTheme {
}

export interface IWorkbenchProductIconTheme extends IWorkbenchTheme, IProductIconTheme {
	readonly settingsId: string;

	getIcon(icon: IconContribution): IconDefinition | undefined;
}

export type ThemeSettingTarget = ConfigurationTarget | undefined | 'auto' | 'preview';


export interface IWorkbenchThemeService extends IThemeService {
	readonly _serviceBrand: undefined;
	setColorTheme(themeId: string | undefined | IWorkbenchColorTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchColorTheme | null>;
	getColorTheme(): IWorkbenchColorTheme;
	/** Returns the selected theme and user customizations without window-local overlays. */
	getBaseColorTheme(): IWorkbenchColorTheme;
	getColorThemes(): Promise<IWorkbenchColorTheme[]>;
	getMarketplaceColorThemes(publisher: string, name: string, version: string): Promise<IWorkbenchColorTheme[]>;
	readonly onDidColorThemeChange: Event<IWorkbenchColorTheme>;

	/** Applies window-local colors computed from the base theme, without persisting them or changing the selected theme. */
	registerColorThemeOverlay(getColors: (theme: IWorkbenchColorTheme) => IColorMap): IDisposable;

	getPreferredColorScheme(): ColorScheme | undefined;

	setFileIconTheme(iconThemeId: string | undefined | IWorkbenchFileIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchFileIconTheme>;
	getFileIconTheme(): IWorkbenchFileIconTheme;
	getFileIconThemes(): Promise<IWorkbenchFileIconTheme[]>;
	getMarketplaceFileIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchFileIconTheme[]>;
	readonly onDidFileIconThemeChange: Event<IWorkbenchFileIconTheme>;

	setProductIconTheme(iconThemeId: string | undefined | IWorkbenchProductIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchProductIconTheme>;
	getProductIconTheme(): IWorkbenchProductIconTheme;
	getProductIconThemes(): Promise<IWorkbenchProductIconTheme[]>;
	getMarketplaceProductIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchProductIconTheme[]>;
	readonly onDidProductIconThemeChange: Event<IWorkbenchProductIconTheme>;
}

export interface IThemeScopedColorCustomizations {
	[colorId: string]: string;
}

export interface IColorCustomizations {
	[colorIdOrThemeScope: string]: IThemeScopedColorCustomizations | string;
}

export interface IThemeScopedTokenColorCustomizations {
	[groupId: string]: ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface ITokenColorCustomizations {
	[groupIdOrThemeScope: string]: IThemeScopedTokenColorCustomizations | ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface IThemeScopedSemanticTokenColorCustomizations {
	[styleRule: string]: ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface ISemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedSemanticTokenColorCustomizations | ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface IThemeScopedExperimentalSemanticTokenColorCustomizations {
	[themeScope: string]: ISemanticTokenRules | undefined;
}

export interface IExperimentalSemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedExperimentalSemanticTokenColorCustomizations | ISemanticTokenRules | undefined;
}

export type IThemeScopedCustomizations =
	IThemeScopedColorCustomizations
	| IThemeScopedTokenColorCustomizations
	| IThemeScopedExperimentalSemanticTokenColorCustomizations
	| IThemeScopedSemanticTokenColorCustomizations;

export type IThemeScopableCustomizations =
	IColorCustomizations
	| ITokenColorCustomizations
	| IExperimentalSemanticTokenColorCustomizations
	| ISemanticTokenColorCustomizations;

export interface ISemanticTokenRules {
	[selector: string]: string | ISemanticTokenColorizationSetting | undefined;
}

export interface ITextMateThemingRule {
	name?: string;
	scope?: string | string[];
	settings: ITokenColorizationSetting;
}

export interface ITokenColorizationSetting {
	foreground?: string;
	background?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	fontFamily?: string;
	fontSize?: number;
	lineHeight?: number;
}

export interface ISemanticTokenColorizationSetting {
	foreground?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	bold?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	italic?: boolean;
}

export interface ExtensionData {
	extensionId: string;
	extensionPublisher: string;
	extensionName: string;
	extensionIsBuiltin: boolean;
}

export namespace ExtensionData {
	export function toJSONObject(d: ExtensionData | undefined): any {
		return d && { _extensionId: d.extensionId, _extensionIsBuiltin: d.extensionIsBuiltin, _extensionName: d.extensionName, _extensionPublisher: d.extensionPublisher };
	}
	export function fromJSONObject(o: any): ExtensionData | undefined {
		if (o && isString(o._extensionId) && isBoolean(o._extensionIsBuiltin) && isString(o._extensionName) && isString(o._extensionPublisher)) {
			return { extensionId: o._extensionId, extensionIsBuiltin: o._extensionIsBuiltin, extensionName: o._extensionName, extensionPublisher: o._extensionPublisher };
		}
		return undefined;
	}
	export function fromName(publisher: string, name: string, isBuiltin = false): ExtensionData {
		return { extensionPublisher: publisher, extensionId: `${publisher}.${name}`, extensionName: name, extensionIsBuiltin: isBuiltin };
	}
}

export interface IThemeExtensionPoint {
	id: string;
	label?: string;
	description?: string;
	path: string;
	uiTheme?: ThemeTypeSelector;
	_watch: boolean; // unsupported options to watch location
}
