/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/* Copyright (C) 2023 Max Nikulin */

"use strict";

var mwel = mwel ?? new (function mwel() {})();

(function mwel_abortable(mwel) {
	class _RejectableDeferred {
		constructor() {
			this.promise = new Promise((_, reject) => { this.reject = reject; });
		}
	}

	class _AbortableContextBase {
		_destructors = new Set();

		constructor (parent) {
			console.assert(!parent?.aborted); // checked by caller
			this._controller = new AbortController();
			this._destructors.add(this._addListener(
				this._controller.signal, this._onAbort.bind(this)));
			this._externalHandler = ev => this._controller.abort(ev?.target?.reason);
			this._destructors.add(parent?.addListener(this._externalHandler));
		}
		get aborted() {
			return this._controller.signal.aborted;
		}
		throwIfAborted() {
			this._controller.signal.throwIfAborted();
		}
		get with() {
			this.throwIfAborted();
			return this._with;
		}
		_with(signal) {
			return new AbortableContext(signal, this);
		}
		get abortable() {
			this.throwIfAborted();
			return this._abortable;
		}
		destroy(reason) {
			this._controller.abort(reason ?? new Error("Context destroyed"));
			this._destroyed = true;
			Object.defineProperty(this, "_controller", {
				configurable: true,
				get() { throw new Error("Destroyed"); },
			});
		}
		addListener(cb) {
			// TODO Should `cb` be called if `this._destroyed || this.aborted`?
			this.throwIfAborted();
			const { signal } = this._controller;
			return this._addListener(signal, cb);
		}
		_addListener(signal, cb) {
			const params = { once: true };
			signal.addEventListener("abort", cb, params);
			return signal.removeEventListener.bind(signal, "abort", cb, params);
		}
		_onAbort(ev) {
			const reason = ev?.target?.reason ?? new Error("Context aborted");
			const destructors = [...this._destructors].reverse();
			this._destructors.clear();
			for (let i = destructors.length; i-- > 0; ) {
				try {
					destructors[i]?.(reason);
				} catch (ex) {
					this._warn(ex);
				}
			}
			this._externalHandler = undefined;
		}
		/// `_warn(Error)`
		get _warn() {
			return Promise.reject;
		}
	}

	class AbortableContext extends _AbortableContextBase {
		constructor(signal, parent) {
			signal?.throwIfAborted();
			super(parent);
			if (signal) {
				this._destructors.add(this._addListener(signal, this._externalHandler));
			}
		}
		async _abortable(promise) {
			// Arbitrary delay may happen between getting the `abortable` property
			// and evaluation of `ctx.abortable()` argument due to e.g. an `alert()`
			// blocking event handler caused by synchronous `document.execCommand()`,
			this.throwIfAborted();
			const runner = new _AbortableContextRunner(this);
			try {
				return await runner.abortable(promise);
			} finally {
				runner.destroy();
			}
		}
		async run(func) {
			this.throwIfAborted();
			const runner = new _AbortableContextRunner(this);
			try {
				return await func(runner);
			} finally {
				runner.destroy();
			}
		}
	}

	class _AbortableContextRunner extends _AbortableContextBase {
		constructor(parent) {
			super(parent);
			this._destructors.add(this._rejectDeferred.bind(this));
			if (parent == null) {
				this._warn(new Error("Parent is not specified"));
			}
		}
		async run(func) {
			return await this.abortable(func(this));
		}
		_abortable(thenable) {
			return Promise.race([thenable, this._promise]);
		}
		get _promise() {
			let deferred = this._deferred;
			if (deferred === undefined) {
				deferred = this._deferred = new _RejectableDeferred();
			}
			return deferred.promise;
		}
		_rejectDeferred(reason) {
			const deferred = this._deferred;
			if (deferred === undefined) {
				return;
			}
			deferred.reject(reason);
			delete this._deferred;
		}
	}
	Object.assign(mwel, {
		AbortableContext,
		_AbortableContextBase,
		_AbortableContextRunner,
		_RejectableDeferred,
	});
	return mwel;
})(mwel);
