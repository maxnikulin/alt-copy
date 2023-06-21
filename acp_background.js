/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/* Copyright (C) 2021-2023 Max Nikulin */

"use strict";

// 5000 is user activation interval.
var ACP_CONTENT_SCRIPT_TIMEOUT = 768;

var acpAbortController;

function acpMenusCreate() {
	browser.menus.create(
		{
			// TODO consider explicit list "page", "video", etc.
			contexts: [ "all" ],
			enabled: true,
			id: "ACP_COPY",
			title: chrome.i18n.getMessage("copyContextMenu"),
		},
		function acpMenusCreateCallback() {
			if (browser.runtime.lastError) {
				console.error("acpCreateMenu: %o", browser.runtime.lastError);
			}
		}
	);
}

async function acpExecuteContentScript(ctx, injectionTarget) {
	try {
		const resultArray = await ctx.with(AbortSignal.timeout(ACP_CONTENT_SCRIPT_TIMEOUT))
			.abortable(browser.scripting.executeScript(injectionTarget));
		if (!Array.isArray(resultArray) || resultArray.length !== 1) {
			console.warn(
				"acp: scripting.executeScript(%): returned not an Array(1): %o",
				injectionTarget, resultArray);
			return { error: new TypeError("Unexpected executeScript return value") };
		}
		const injectionResult = resultArray?.[0];
		if (injectionResult === undefined) {
			// https://bugzilla.mozilla.org/1824901
			// "WebExtensions scripting.executeScript() returns [undefined] array for about:debugging page"
			return { error: new Error("Content script injection failed: privileged content") };
		}
		const error = injectionResult?.error;
		if (error !== undefined) {
			return { error };
		}
		const scriptResult = injectionResult?.result;
		if (
			scriptResult != null
			&& ("result" in scriptResult) || ("error" in scriptResult)
		) {
			return scriptResult;
		} else {
			console.warn("acp: content script return value is not result/error object: %o", scriptResult);
			return { result: scriptResult };
		}
	} catch (ex) {
		return { error: ex };
	}
}

/** If user activation for DOM API propagates to the add-on background page
 *
 * Works in Firefox-113, but not in Firefox-102 ESR.
 *
 * Without `clipboardWrite` permission `navigator.clipboard.writeText(text)`
 * and `document.execCommand("copy") work in Firefox-113 within 5 seconds
 * after `menus.onClicked`, `commands.onCommand`, or `browserAction.onClicked`
 * events are fired. In Firefox-102 `writeText` throws
 * `DOMException: Clipboard write was blocked due to lack of user activation.`
 * and `execCommand` returns `false` causing the following warning in console
 *
 *     `document.execCommand(‘cut’/‘copy’) was denied because it was not called from inside a short running user-generated event handler.
 *
 * https://bugzilla.mozilla.org/1835585
 *
 * `navigator.userActivation` is not supported by Firefox.
 */
function acpHasDOMUserActivationInBackground() {
	// Appeared in Firefox-112
	return navigator.getAutoplayPolicy !== undefined;
}

function acpMakePermissionsRequest(clickData, tab) {
	// Firefox (but not Chrome) mv2 (but not mv3) add-ons can
	// inject content scripts into cross-origin frames
	// when they are created from original HTML content
	// <https://bugzilla.mozilla.org/1396399>
	// and unless the tab is restored from cache
	// <https://bugzilla.mozilla.org/1837336>
	// So `origins` permissions are mostly not necessary.

	if (acpHasDOMUserActivationInBackground()) {
		// `navigator.clipboard.writeText` may be called from background
		// without the `clipboardWrite` permission.
		return null;
	}
	const retval = { permissions: [ "clipboardWrite" ] };
	if (!(tab?.id >= 0)) {
		// E.g. in the case of browser action for add-on popup
		// or sidebar of another add-on.
		// `tab === undefined` and `clickData.viewType === "popup"`
		return retval;
	}
	const url = tab?.url ?? clickData.pageUrl ?? clickData.frameUrl;
	if (typeof url !== "string") {
		console.warn("acp: can not get URL", clickData, tab);
		return retval;
	}
	if (url === "about:srcdoc") {
		return null;
	}
	if (url === "about:blank") {
		// Either completely blank and so nothing to extract
		// or it is filled by opener and accessible.
		return null;
	}
	// TODO `javascript:`?
	const privileged = [ "about:", "moz-extension:", "view-source:", "resource:" ];
	if (privileged.some(p => url.startsWith(p))) {
		return retval;
	}
	if (tab?.isInReaderMode) {
		return retval;
	}
	try {
		// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts#restricted_domains
		const hosts = [
			"accounts-static.cdn.mozilla.net",
			"accounts.firefox.com",
			"addons.cdn.mozilla.net",
			"addons.mozilla.org",
			"api.accounts.firefox.com",
			"content.cdn.mozilla.net",
			"discovery.addons.mozilla.org",
			"install.mozilla.org",
			"oauth.accounts.firefox.com",
			"profile.accounts.firefox.com",
			"support.mozilla.org",
			"sync.services.mozilla.com",
		];
		const urlObject = new URL(url);
		if (hosts.indexOf(urlObject.hostname) >= 0 || /\.pdf$/i.test(urlObject.path)) {
			return retval;
		}
	} catch (ex) {
		Promise.reject(ex);
		return null;
	}
	return null;
}

async function acpRunExtract(ctx, clickData, tab) {
	try {
		if (!(tab?.id >= 0)) {
			// Can not inject script, no reason to repeat.
			return { result: "" };
		}
		const { targetElementId, frameId } = clickData;
		const target = { tabId: tab.id };
		if (frameId > 0) {
			target.frameIds = [ frameId ];
		};
		return await acpExecuteContentScript(ctx, {
			target,
			func: acpContentScriptExtract,
			args: [ targetElementId ?? null ],
		});
	} catch (error) {
		return { error };
	}
}

async function acpRunCopy(ctx, clickData, tab, selection) {
	if (!(tab?.id >= 0)) {
		// Can not inject script, no reason to repeat.
		return { result: "NO_TAB" };
	}
	const target = { tabId: tab.id };
	const { frameId } = clickData;
	if (frameId > 0) {
		target.frameIds = [ frameId ];
	};
	const frameResult = await ctx.abortable(acpExecuteContentScript(ctx, {
		target,
		func: acpContentScriptCopy,
		args: [ selection ],
	}));
	if (
		frameResult?.result === true
		|| target.frameIds === undefined
	) {
		return frameResult;
	}
	delete target.frameIds
	console.log("acp: retry copy through the top level frame");
	return await ctx.abortable(acpExecuteContentScript(ctx, {
		target,
		func: acpContentScriptCopy,
		args: [ selection ],
	}));
}

async function acpCopy(ctx, clickData, tab) {
	let permissionsRequest;
	let permissionsPromise;
	try {
		permissionsRequest = acpMakePermissionsRequest(clickData, tab);
		if (permissionsRequest != null) {
			/* No `await` before due to
			 * https://bugzilla.mozilla.org/1398833
			 * "chrome.permissions.request needs to be called directly from input handler,
			 * making it impossible to check for permissions first"
			 *
			 * Do not `await` result to run content script before
			 * user decision. It should minimize chance that the target element
			 * will disappear from DOM.
			 */
			permissionsPromise = browser.permissions.request(permissionsRequest);
		}
	} catch (ex) {
		// Log with actual `lineNumber`.
		Promise.reject(ex);
	}

	// Try to extract.
	const extractResult = await ctx.abortable(acpRunExtract(ctx, clickData, tab));

	let selection = extractResult?.result;
	if (typeof selection !== "string") {
		console.warn("acp: extract: %o", extractResult);
	}

	// Fallback to `clickData`
	if (!selection) {
		console.log("acp: fallback to selection text");
		selection = clickData.selectionText || clickData.linkText ||
			clickData.linkUrl || clickData.srcUrl;
	}
	if (!selection) {
		throw new Error("nothing to copy");
	}
	selection = acpReplaceSpecial(selection);

	let withPermissions;
	try {
		withPermissions = !permissionsRequest
			|| await browser.permissions.contains(permissionsRequest);
	} catch (ex) {
		Promise.reject(ex);
	}

	// Try to copy from background page.
	let copyBgResult;
	const hasBgUserActivation = acpHasDOMUserActivationInBackground();
	try {
		if (hasBgUserActivation || withPermissions) {
			try {
				await ctx.abortable(navigator.clipboard.writeText(selection));
				return;
			} catch (error) {
				copyBgResult = { error };
				if (hasBgUserActivation) {
					console.error(
						"acp: copy from background failed.");
				}
			}
		}
	} catch (ex) {
		ctx.throwIfAborted();
		Promise.reject(ex);
	}

	// First fallback to copy from content script.
	let copyScriptResult;
	try {
		copyScriptResult = await acpRunCopy(ctx, clickData, tab, selection);
		if (copyScriptResult?.result === true) {
			return;
		}
	} catch (error) {
		copyScriptResult = { error };
	}
	ctx.throwIfAborted();

	// Wait user permissions decision.
	try {
		if (permissionsPromise !== undefined) {
			permissionsPromise = await ctx.abortable(permissionsPromise);
		}
	} catch (ex) {
		ctx.throwIfAborted();
		Promise.reject(ex);
	}

	// If permission request is rejected by the user then retries
	// should help in the case of logical errors in the code.

	// Retry copy from background.
	try {
		if (copyBgResult === undefined || !withPermissions)  {
			await ctx.abortable(navigator.clipboard.writeText(selection));
			return;
		}
	} catch (error) {
		ctx.throwIfAborted();
		copyBgResult = { error };
	}

	// Retry copy from content script.
	try {
		if (!withPermissions) {
			copyScriptResult = await acpRunCopy(ctx, clickData, tab, selection);
			if (copyScriptResult?.result === true) {
				return;
			}
		}
	} catch (error) {
		copyScriptResult = { error };
	}
	ctx.throwIfAborted();

	if (permissionsPromise !== undefined && permissionsPromise !== true) {
		console.warn("acp: permissions are not granted");
	}
	console.warn("acp: background copy: %o", copyBgResult);
	console.warn("acp: content script copy: %o", copyScriptResult);
	throw new Error("Failed to copy");
}

function acpReplaceSpecial(text) {
	return text.replace(/\t/g, '        ').
		replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F-\x9F\uFEFF]/g, "\uFFFD");
}

async function acpMenusListener(clickData, tab) {
	console.assert(clickData.menuItemId === "ACP_COPY");
	try {
		acpAbortController?.abort(new Error("New copy requested"));
	} catch (ex) {
		Promise.reject(ex);
	}
	let controller;
	try {
		controller = acpAbortController = new AbortController();
	} catch (ex) {
		Promise.reject(ex);
	}
	try {
		await new mwel.AbortableContext(controller?.signal).run(
			ctx => acpCopy(ctx, clickData, tab));
	} catch(ex) {
		console.log(
			"acpMenusListener(%o, %o): exception",
			clickData, tab);
		throw ex;
	} finally {
		if (acpAbortController === controller) {
			acpAbortController = undefined;
		}
	}
}

function acpMain() {
	// Do not use
	//
	//     browser.runtime.onInstalled.addListener(acpMenusCreate);
	//
	// recommended in Chromium docs. It requires
	//
	//     { "background": { "persistent": false } }
	//
	// in `manifest.json`, however Firefox does not support event pages,
	// so menu entries should be created each time when add-on is loading.
	acpMenusCreate();
	/* Discard `Promise` to get error in extension developer tools in Firefox
	 * that otherwise reported to browser console only. Is a workaround for:
	 * https://bugzilla.mozilla.org/1398672
	 * "1398672 - Add test for better logging of exceptions/rejections from async event"
	 */
	browser.menus.onClicked.addListener((clickData, tab) => void acpMenusListener(clickData, tab));
}

acpMain();
