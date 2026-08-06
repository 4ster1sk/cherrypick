/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { MFM_TAGS, HTML_TAGS } from '@@/js/const.js';
import * as os from '@/os.js';
import { i18n } from '@/i18n.js';
import type { MenuItem } from '@/types/menu.js';

/**
 * MFMの装飾のリストを表示する
 */
export function mfmFunctionPicker(anchorElement: HTMLElement | EventTarget | null, onChosen: (tag: string) => void, onClosed?: () => void) {
	os.popupMenu([{
		text: i18n.ts.addMfmFunction,
		type: 'label',
	}, ...getHTMLFunctionList(onChosen)
	, { type: 'divider' }
	, ...MFM_TAGS.map(tag => ({
		text: tag,
		icon: 'ti ti-icons',
		action: () => {
			onChosen(tag);
		},
	}))], anchorElement, {
		onClosed: () => {
			if (onClosed) onClosed();
		},
	});
}

function getHTMLFunctionList(onChosen: (tag: string) => void): MenuItem[] {
	return HTML_TAGS.map(tag => ({
		text: tag,
		icon: tag === 'bold' ? 'ti ti-bold' : tag === 'strike' ? 'ti ti-strikethrough' : tag === 'italic' ? 'ti ti-italic' : tag === 'small' ? 'ti ti-text-decrease' : tag === 'center' ? 'ti ti-align-center' : tag === 'plain' ? 'ti ti-clear-formatting' : tag === 'inlinecode' ? 'ti ti-code' : tag === 'blockcode' ? 'ti ti-script' : tag === 'mathinline' ? 'ti ti-math' : tag === 'mathblock' ? 'ti ti-math-function' : 'ti ti-icons',
		action: () => onChosen(tag),
	}));
}
