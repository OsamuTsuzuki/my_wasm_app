import("./main.js?v=2.0");
(async () => {
    const slots = document.querySelectorAll('[data-include]');
    for (const el of slots) {
        const url = el.getAttribute('data-include');
        const html = await (await fetch(url)).text();
        el.innerHTML = html;
    }

  // include読み込み完了後にイベントを仕込む
        const helpToggle = document.getElementById('helpToggle');
        const helpText = document.getElementById('helpText');
        helpToggle?.addEventListener('change', () => { helpText.hidden = !helpToggle.checked; });

        document.getElementById('btnReset')?.addEventListener('click', () => {
            const ev = new KeyboardEvent('keydown', { key: 'r', ctrlKey: true });
            document.dispatchEvent(ev);
        });
})();
