import init, { pre_process, next_frame } from "./pkg/flip_book.js";

// ===== ユーティリティ =====
async function loadJsonConfig(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`設定ファイル読み込みに失敗: ${res.status}`);
    return await res.json();
}

// 画像 → RGB Raw（Uint8Array, 3ch）
async function loadRawRGBData(url) {
    const img = new Image();
    img.crossOrigin = "anonymous"; // 同一オリジン前提なら不要
    img.src = url;
    await img.decode();

    const canvas = document.createElement("canvas");
    canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const rgba = ctx.getImageData(0, 0, img.width, img.height).data;

    const rgb = new Uint8Array((rgba.length / 4) * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4) {
        rgb[j++] = rgba[i];     // R
        rgb[j++] = rgba[i + 1]; // G
        rgb[j++] = rgba[i + 2]; // B
    }
    return rgb;
}

// PNGバイト列 → ImageBitmap（高速描画）
async function bytesToBitmap(pngBytes) {
    const blob = new Blob([pngBytes], { type: "image/png" });
    // createImageBitmapはPNGを直接デコード可能
    return await createImageBitmap(blob);
}

// ===== レンダラ（入力→WASM→PNG→Canvas） =====
class FrameRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
        this.isBusy = false;        // 描画中ガード
        this.pendingSignal = null;  // 最新の未処理信号（上書き式）

        // 繰り返し送信のためのハンドル
        this.holdInterval = null;   // キー押下中のループ
        this.autoInterval = null;   // 自動パンのループ
    }

    async requestFrame(signal) {
        // 最新の要求だけを残す（過負荷抑制）
        if (this.isBusy) { this.pendingSignal = signal; return; }
        this.isBusy = true;

        try {
            // Rust next_frame のシグネチャ互換（引数あり/なし両対応）
            let start = performance.now();
            let rgba;
            if (typeof next_frame === "function" && next_frame.length >= 1) {
                rgba = next_frame(signal);
            } else {
                rgba = next_frame();
            }
            let end = performance.now();
            console.log("処理時間:", end - start, "ms");
            // console.log("RUST_MARK =", globalThis.RUST_MARK);
            if (rgba.length === 0) {
                console.log("フレームスキップ");
                return; // 前のフレームを維持（描画しない）
            }
            // 描画
            const imageData = new ImageData(
                new Uint8ClampedArray(rgba),
                this.canvas.width,
                this.canvas.height
            );
            this.ctx.putImageData(imageData, 0, 0);
        } finally {
            this.isBusy = false;
            // 蓄積されていれば最後の要求を即実行
            if (this.pendingSignal !== null) {
                const sig = this.pendingSignal; this.pendingSignal = null;
                // ノンブロッキングに次をキック
                queueMicrotask(() => this.requestFrame(sig));
            }
        }
    }

    // ===== 押しっぱ（手動連続） =====
    startHoldLoop(signal, ms = 125) {
        this.stopHoldLoop();
        this.requestFrame(signal);
        this.holdInterval = setInterval(() => this.requestFrame(signal), ms);
    }
    stopHoldLoop() {
        if (this.holdInterval) { clearInterval(this.holdInterval); this.holdInterval = null; }
    }

    // ===== 自動パン（Shift+H / Shift+L） =====
    startAuto(signal, ms = 80) {
        this.stopAuto();
        this.autoInterval = setInterval(() => this.requestFrame(signal), ms);
    }
    stopAuto() {
        if (this.autoInterval) { clearInterval(this.autoInterval); this.autoInterval = null; }
    }
}

// ===== メイン =====
(async function run() {
    await init();
    console.log("JS: WebAssembly 初期化完了");

    // ページ名 → JSON名（settings ディレクトリ）
    const htmlFilename = window.location.pathname.split("/").pop();
    const jsonFilename = htmlFilename.replace(/\.html$/, ".json");

    // コンフィグ読み込み
    const configList = await loadJsonConfig(`settings/${jsonFilename}`);
    const ch = 0; // 必要ならメニューで切替
    const mainConf = configList[ch];

    // Canvas 準備
    const canvas = document.getElementById("display");
    canvas.width = mainConf.twidth;
    canvas.height = mainConf.theight;

    // ソース画像読み込み（images ディレクトリ想定）
    const rawImage = await loadRawRGBData(`images/${mainConf.simg}`);

    // Rust 前処理
    const configStr = JSON.stringify(configList);
    pre_process(rawImage, configStr, ch);
    console.log("前処理が正常に完了");

    const renderer = new FrameRenderer(canvas);

    // キー → 信号マップ
    const KeyToSignal = {
        "h": 4,
        "j": 2,
        "k": 8,
        "l": 6,
        "i": 11,
        "o": 10,
    };

    // 起動時：初期画像（信号0）
    await renderer.requestFrame(0);

    // 状態
    let autoMode = false; // 自動パン中か

    function stopAllLoops() {
        renderer.stopHoldLoop();
        renderer.stopAuto();
    }

    // Keydown（1枚送り or 押下連続 or 自動開始）
    document.addEventListener("keydown", (ev) => {
        // リピートは無視（押しっぱは自前ループ）
        if (ev.repeat) return;

        // Ctrl+R → 初期位置（信号0）
        if ((ev.key === "r" || ev.key === "R") && ev.ctrlKey && !ev.metaKey) {
            ev.preventDefault();
            autoMode = false;
            stopAllLoops();
            renderer.requestFrame(0);
            return;
        }

        // N → ティルトリセット（信号5）
        if (ev.key === "n" && !ev.shiftKey) {
            autoMode = false; stopAllLoops();
            renderer.requestFrame(5);
            return;
        }

        // Shift+H / Shift+L → 自動パン（4 or 6連続）
        if (ev.shiftKey && (ev.key === "H" || ev.key === "L")) {
            autoMode = true; stopAllLoops();
            const sig = ev.key === "H" ? 4 : 6;
            renderer.startAuto(sig, 30); // 80から修正
            return;
        }

        // h/j/k/l/i/o → 押している間だけ連続
        const lower = ev.key.toLowerCase();
        if (!ev.shiftKey && KeyToSignal.hasOwnProperty(lower)) {
            autoMode = false; renderer.stopAuto();
            const sig = KeyToSignal[lower];
            renderer.startHoldLoop(sig, 30);  // 125から修正
            return;
    
        }
    });

    // Keyup（押下連続の停止、自動はH/Lで止める）
    document.addEventListener("keyup", (ev) => {
        const lower = ev.key.toLowerCase();

        // h/j/k/l/i/o の押しっぱ停止
        if (["h","j","k","l","i","o"].includes(lower) && !ev.shiftKey) {
            renderer.stopHoldLoop();
        }

        // H/L（シフトなし）で自動停止
        if (["h","l"].includes(lower) && !ev.shiftKey && autoMode) {
            autoMode = false; renderer.stopAuto();
        }
    });

    // ===== マウス操作 → 信号変換 =====
    function getSignalFromMouse(x, y) {
        const w = canvas.width;
        const h = canvas.height;

        if (y < h / 4 - 1) {
            if (x < w / 4 - 1) return 7;
            else if (x < (w * 3) / 4 - 1) return 8;
            else return 9;
        } else if (y < (h * 3) / 4 - 1) {
            if (x < w / 2 - 1) return 4;
            else return 6;
        } else {
            if (x < w / 4 - 1) return 1;
            else if (x < (w * 3) / 4 - 1) return 2;
            else return 3;
        }
    }

    // 左クリック押下で連続送信開始
    canvas.addEventListener("mousedown", (ev) => {
        if (ev.button !== 0) return; // 左クリックのみ
        const rect = canvas.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const y = ev.clientY - rect.top;
        const sig = getSignalFromMouse(x, y);

        autoMode = false; stopAllLoops();
        renderer.startHoldLoop(sig, 30);  // ← キー操作と同じ方式
    });

    // マウス離したら停止
    canvas.addEventListener("mouseup", (ev) => {
        if (ev.button !== 0) return;
        renderer.stopHoldLoop();
    });

    // ===== タッチ操作（スマホ用） =====
    let touchStartX = 0, touchStartY = 0, touchStartDist = 0;

    function getDistance(touches) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    // タッチ開始
    canvas.addEventListener("touchstart", (ev) => {
        if (ev.touches.length === 1) {
            // 1本指スワイプ
            touchStartX = ev.touches[0].clientX;
            touchStartY = ev.touches[0].clientY;
        } else if (ev.touches.length === 2) {
            // 2本指ピンチ
            touchStartDist = getDistance(ev.touches);
        }
    }, { passive: true });

    // スワイプ判定（指を動かしている間に連続送信開始）
    canvas.addEventListener("touchmove", (ev) => {
        if (ev.touches.length === 1) {
            const dx = ev.touches[0].clientX - touchStartX;
            const dy = ev.touches[0].clientY - touchStartY;

            const threshold = 20; // スワイプ判定のしきい値(px)
            if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > threshold) {
                // 横スワイプ
                if (dx > 0) {
                    renderer.startHoldLoop(4, 30); // → 信号4
                } else {
                    renderer.startHoldLoop(6, 30); // ← 信号6
                }
            } else if (Math.abs(dy) > threshold) {
                // 縦スワイプ
                if (dy > 0) {
                    renderer.startHoldLoop(8, 30); // ↓ 信号8
                } else {
                    renderer.startHoldLoop(2, 30); // ↑ 信号2
                }
            }
        } else if (ev.touches.length === 2) {
            // ピンチ操作
            const dist = getDistance(ev.touches);
            const diff = dist - touchStartDist;
            const threshold = 10;

            if (Math.abs(diff) > threshold) {
                if (diff > 0) {
                    renderer.startHoldLoop(11, 80); // ピンチアウト → 信号11
                } else {
                    renderer.startHoldLoop(10, 80); // ピンチイン → 信号10
                }
                touchStartDist = dist;
            }
        }
    }, { passive: true });

    // 指を離したら停止（1本でも2本でも止める）
    canvas.addEventListener("touchend", (ev) => {
        if (ev.touches.length === 0) {
            renderer.stopHoldLoop();
        }
    }, { passive: true });

    // ===== 自動パン設定（JSON "auto" フィールド対応） =====
    if ("auto" in mainConf) {
        const sig = mainConf.auto ? 6 : 4;
        renderer.startAuto(sig, 30);   // 既存の startAuto を流用
        autoMode = true;
        console.log(`自動パン開始: 信号${sig}`);
    }

})();
