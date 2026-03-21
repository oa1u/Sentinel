if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', async () => {
        try {
            const res = await fetch('/Config/main.json');
            if (!res.ok) return;
            const data = await res.json();
            const version = data.Version || data.version || null;
            if (version) {
                const footer = document.querySelector('.page-footer .footer-links');
                if (footer && !footer.querySelector('.footer-version')) {
                    const versionSpan = document.createElement('span');
                    versionSpan.className = 'footer-version';
                    versionSpan.style.marginLeft = '0.35em';
                    versionSpan.style.fontWeight = 'normal';
                    versionSpan.style.fontSize = 'inherit';
                    versionSpan.style.color = '';
                    versionSpan.textContent = `• Version ${version}`;
                    footer.appendChild(versionSpan);
                }
            }
        } catch (e) {
        }
    });
}