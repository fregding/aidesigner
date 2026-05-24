(function () {
    function getToolToastStack() {
        let stack = document.querySelector('.tool-toast-stack');
        if (!stack) {
            stack = document.createElement('div');
            stack.className = 'tool-toast-stack';
            document.body.appendChild(stack);
        }
        return stack;
    }

    function showToolNotice(message) {
        const stack = getToolToastStack();
        const toast = document.createElement('div');
        toast.className = 'tool-toast-pill';
        const dot = document.createElement('span');
        const text = document.createElement('span');
        dot.className = 'tool-toast-dot';
        text.textContent = message;
        toast.append(dot, text);
        stack.appendChild(toast);

        requestAnimationFrame(() => toast.classList.add('show'));
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 240);
        }, 2200);
    }

    window.showToolNotice = showToolNotice;

    function isMobileMediaSaveDevice() {
        const ua = navigator.userAgent || navigator.vendor || '';
        return /iPhone|iPad|iPod|Android|Mobile/i.test(ua);
    }

    function isAppleMobileMediaDevice() {
        const ua = navigator.userAgent || navigator.vendor || '';
        return /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }

    function inferFilenameExtension(url, fallback) {
        try {
            const cleanPath = String(url || '').split('?')[0].split('#')[0];
            const match = cleanPath.match(/\.([a-z0-9]{2,5})$/i);
            if (match) return '.' + match[1].toLowerCase();
        } catch (error) {
            return fallback || '';
        }
        return fallback || '';
    }

    function inferMimeFromFilename(filename, fallback) {
        const ext = inferFilenameExtension(filename, '').toLowerCase();
        const map = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.gif': 'image/gif',
            '.heic': 'image/heic',
            '.heif': 'image/heif',
            '.mp4': 'video/mp4',
            '.mov': 'video/quicktime',
            '.webm': 'video/webm',
            '.m4v': 'video/x-m4v',
            '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        };
        return map[ext] || fallback || 'application/octet-stream';
    }

    function sanitizeDownloadFilename(value, fallback, extension) {
        const ext = extension || inferFilenameExtension(value, '');
        const withoutExt = String(value || '')
            .replace(/\.[a-z0-9]{2,5}$/i, '')
            .replace(/[^\u4e00-\u9fa5a-zA-Z0-9_-]+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 36);
        return (withoutExt || fallback || 'download') + (ext || '');
    }

    function dataUrlToBlob(dataUrl) {
        const parts = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/);
        if (!parts) throw new Error('无效的文件数据');
        const mime = parts[1] || 'application/octet-stream';
        const isBase64 = Boolean(parts[2]);
        const raw = isBase64 ? atob(parts[3]) : decodeURIComponent(parts[3]);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) {
            bytes[i] = raw.charCodeAt(i);
        }
        return new Blob([bytes], { type: mime });
    }

    function makeAbsoluteUrl(url) {
        return new URL(url, window.location.href).href;
    }

    function isSameOriginUploadUrl(url) {
        try {
            const parsed = new URL(url, window.location.href);
            return parsed.origin === window.location.origin && parsed.pathname.startsWith('/uploads/');
        } catch (error) {
            return String(url || '').startsWith('/uploads/');
        }
    }

    function apiUrl(path) {
        const base = window.location.protocol === 'file:' ? 'http://localhost:3000' : '';
        return base + path;
    }

    function buildDownloadProxyUrl(url, filename, mediaType) {
        if (isSameOriginUploadUrl(url)) {
            return url;
        }
        if (mediaType === 'image') {
            const params = new URLSearchParams({
                url: url,
                filename: filename || 'ai-image'
            });
            return apiUrl('/api/ai/image-download?' + params.toString());
        }
        return url;
    }

    async function fetchDownloadBlob(url, options) {
        if (/^data:/i.test(url)) return dataUrlToBlob(url);
        const response = await fetch(url, {
            credentials: 'same-origin',
            headers: options && options.authToken
                ? { Authorization: 'Bearer ' + options.authToken }
                : undefined
        });
        if (!response.ok) {
            let message = '文件读取失败';
            try {
                const contentType = response.headers.get('content-type') || '';
                if (contentType.includes('application/json')) {
                    const data = await response.json();
                    message = data.message || data.error || message;
                } else {
                    const text = await response.text();
                    if (text) message = text.slice(0, 120);
                }
            } catch (error) {}
            throw new Error(message);
        }
        return await response.blob();
    }

    async function shareDownloadedFile(url, filename, options) {
        const blob = await fetchDownloadBlob(url, options);
        const type = blob.type || inferMimeFromFilename(filename, options && options.mimeType);
        const file = new File([blob], filename, { type });

        if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
            await navigator.share({
                files: [file],
                title: options && options.title ? options.title : filename
            });
            return true;
        }

        return false;
    }

    function ensureMediaSaveStyles() {
        if (document.getElementById('mediaSaveDialogStyles')) return;
        const style = document.createElement('style');
        style.id = 'mediaSaveDialogStyles';
        style.textContent = [
            '.media-save-overlay{position:fixed;inset:0;z-index:99999;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.52);padding:16px;}',
            '.media-save-sheet{width:min(420px,100%);border:1px solid rgba(255,255,255,.12);border-radius:18px;background:#11131a;color:#fff;box-shadow:0 24px 80px rgba(0,0,0,.45);padding:18px;}',
            '.media-save-title{font-size:1rem;font-weight:800;margin:0 0 6px;}',
            '.media-save-status{margin:0 0 14px;color:rgba(255,255,255,.68);font-size:.88rem;line-height:1.55;}',
            '.media-save-actions{display:grid;gap:10px;}',
            '.media-save-btn{min-height:44px;border:0;border-radius:12px;font:inherit;font-weight:800;cursor:pointer;}',
            '.media-save-btn.primary{background:linear-gradient(135deg,#ff6b4a,#ff9f6b);color:#15110f;}',
            '.media-save-btn.secondary{background:rgba(255,255,255,.08);color:rgba(255,255,255,.8);}',
            '.media-save-btn:disabled{opacity:.52;cursor:not-allowed;}',
            '.media-save-hint{margin:12px 0 0;color:rgba(255,255,255,.48);font-size:.76rem;line-height:1.5;}'
        ].join('');
        document.head.appendChild(style);
    }

    function mediaSaveLabel(mediaType) {
        if (mediaType === 'video') return { noun: '视频', action: '保存视频' };
        if (mediaType === 'image') return { noun: '图片', action: '保存图片' };
        return { noun: '文件', action: '保存文件' };
    }

    function showPreparedMediaSaveSheet(downloadUrl, filename, options) {
        ensureMediaSaveStyles();
        const opts = options || {};
        const label = mediaSaveLabel(opts.mediaType || 'file');
        const overlay = document.createElement('div');
        overlay.className = 'media-save-overlay';
        overlay.innerHTML = [
            '<div class="media-save-sheet" role="dialog" aria-modal="true">',
                '<div class="media-save-title">保存' + label.noun + '</div>',
                '<p class="media-save-status" data-media-save-status>正在准备' + label.noun + '文件...</p>',
                '<div class="media-save-actions">',
                    '<button class="media-save-btn primary" type="button" data-media-save-primary disabled>正在准备...</button>',
                    '<button class="media-save-btn secondary" type="button" data-media-save-fallback>打开文件页</button>',
                    '<button class="media-save-btn secondary" type="button" data-media-save-close>取消</button>',
                '</div>',
                '<p class="media-save-hint">iPhone 需要在文件准备好后再点一次按钮，系统才允许打开“保存到相册”的分享面板。</p>',
            '</div>'
        ].join('');
        document.body.appendChild(overlay);

        const status = overlay.querySelector('[data-media-save-status]');
        const primary = overlay.querySelector('[data-media-save-primary]');
        const fallback = overlay.querySelector('[data-media-save-fallback]');
        const close = overlay.querySelector('[data-media-save-close]');
        let preparedFile = null;
        let objectUrl = '';

        function cleanup() {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            overlay.remove();
        }

        close.addEventListener('click', cleanup);
        fallback.addEventListener('click', () => {
            if (objectUrl) {
                window.open(objectUrl, '_blank', 'noopener');
            } else {
                window.open(downloadUrl, '_blank', 'noopener');
            }
            status.textContent = opts.mediaType === 'video'
                ? '已打开文件页。也可以使用系统分享按钮选择“保存视频”。'
                : '已打开文件页。也可以长按内容保存。';
        });
        primary.addEventListener('click', async () => {
            if (!preparedFile) return;
            try {
                if (navigator.canShare && navigator.canShare({ files: [preparedFile] }) && navigator.share) {
                    await navigator.share({
                        files: [preparedFile],
                        title: opts.title || filename
                    });
                    status.textContent = '系统保存面板已打开。';
                    setTimeout(cleanup, 600);
                    return;
                }
                status.textContent = '当前浏览器不支持直接保存文件，请使用“打开文件页”。';
            } catch (error) {
                if (error && error.name === 'AbortError') {
                    status.textContent = '已取消保存。';
                    return;
                }
                status.textContent = '系统保存面板打开失败，请使用“打开文件页”。';
            }
        });

        fetchDownloadBlob(downloadUrl, opts).then(blob => {
            const type = blob.type || inferMimeFromFilename(filename, opts.mimeType);
            preparedFile = new File([blob], filename, { type });
            objectUrl = URL.createObjectURL(blob);
            primary.disabled = false;
            primary.textContent = label.action + '到相册';
            status.textContent = label.noun + '文件已准备好，请点下面按钮打开系统保存面板。';
        }).catch(error => {
            console.warn('准备保存文件失败:', error.message);
            primary.disabled = true;
            primary.textContent = '准备失败';
            status.textContent = '文件准备失败，请使用“打开文件页”后长按或分享保存。';
        });

        return { method: 'prepared-sheet', filename };
    }

    function triggerBrowserDownload(url, filename, targetBlank) {
        const link = document.createElement('a');
        link.href = url;
        link.download = filename || '';
        if (targetBlank) {
            link.target = '_blank';
            link.rel = 'noopener';
        }
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    async function saveMediaToDevice(sourceUrl, options) {
        const opts = options || {};
        const mediaType = opts.mediaType || 'file';
        const extension = opts.extension || inferFilenameExtension(sourceUrl, mediaType === 'video' ? '.mp4' : mediaType === 'image' ? '.png' : '');
        const filename = sanitizeDownloadFilename(opts.filename || opts.title || '', mediaType === 'video' ? 'ai-video' : mediaType === 'image' ? 'ai-image' : 'download', extension);
        const isMobile = opts.mobile !== undefined ? Boolean(opts.mobile) : isMobileMediaSaveDevice();
        const downloadUrl = opts.proxy === false || /^data:/i.test(sourceUrl)
            ? sourceUrl
            : buildDownloadProxyUrl(sourceUrl, filename, mediaType);

        if (isMobile && isAppleMobileMediaDevice()) {
            return showPreparedMediaSaveSheet(downloadUrl, filename, {
                authToken: opts.authToken || '',
                mimeType: opts.mimeType || inferMimeFromFilename(filename),
                mediaType,
                title: opts.title || filename
            });
        }

        if (isMobile) {
            try {
                const shared = await shareDownloadedFile(downloadUrl, filename, {
                    authToken: opts.authToken || '',
                    mimeType: opts.mimeType || inferMimeFromFilename(filename),
                    title: opts.title || filename
                });
                if (shared) {
                    showToolNotice(mediaType === 'video' ? '已打开系统保存面板，可选择保存视频' : mediaType === 'image' ? '已打开系统保存面板，可选择保存图片' : '已打开系统保存面板');
                    return { method: 'share', filename };
                }
            } catch (error) {
                if (error && error.name === 'AbortError') {
                    return { method: 'cancelled', filename };
                }
                console.warn('系统保存面板不可用，回退下载:', error.message);
            }
        }

        if (/^data:/i.test(downloadUrl)) {
            const blobUrl = URL.createObjectURL(dataUrlToBlob(downloadUrl));
            triggerBrowserDownload(blobUrl, filename, false);
            setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
            return { method: 'blob', filename };
        }

        triggerBrowserDownload(downloadUrl, filename, isMobile);
        return { method: isMobile ? 'open' : 'download', filename };
    }

    window.saveMediaToDevice = saveMediaToDevice;
    window.isMobileMediaSaveDevice = isMobileMediaSaveDevice;
    window.showVideoComingSoon = function showVideoComingSoon(event) {
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }

        window.location.href = 'video.html';
        return false;
    };

    function isVipUser(user) {
        if (!user || (user.role !== 'vip' && !(user.role === 'admin' && user.vip_expires_at))) return false;
        if (!user.vip_expires_at) return true;
        const expiresAt = new Date(user.vip_expires_at).getTime();
        return Number.isFinite(expiresAt) && expiresAt > Date.now();
    }

    function applyVipBadges(user) {
        const isVip = isVipUser(user);
        document.querySelectorAll('#userAvatar, #sidebarAvatar, .user-avatar, .mobile-user-avatar, .avatar').forEach((avatar) => {
            avatar.classList.toggle('is-vip', isVip);
        });
        document.querySelectorAll('#userInitial').forEach((initial) => {
            initial.parentElement?.classList.toggle('is-vip', isVip);
        });
    }

    window.applyVipBadges = applyVipBadges;

    function getAuthToken() {
        return localStorage.getItem('aimaster_token') || '';
    }

    function getMenuQuotaCard() {
        const userMenu = document.getElementById('userMenu');
        if (!userMenu) return null;

        let card = userMenu.querySelector('[data-user-menu-quota]');
        if (card) return card;

        card = document.createElement('a');
        card.className = 'user-menu-quota';
        card.href = 'user.html?view=credits';
        card.setAttribute('data-user-menu-quota', '');
        card.innerHTML = [
            '<div class="user-menu-quota-head">',
                '<span>剩余额度</span>',
                '<strong data-user-quota-remaining>--</strong>',
            '</div>',
            '<div class="user-menu-quota-meta" data-user-quota-meta>正在读取额度...</div>'
        ].join('');

        userMenu.insertBefore(card, userMenu.firstElementChild);
        return card;
    }

    function formatQuotaNumber(value) {
        const number = Number(value || 0);
        if (!Number.isFinite(number)) return '0';
        return number.toLocaleString('zh-CN');
    }

    function renderMenuQuota(quota) {
        const card = getMenuQuotaCard();
        if (!card) return;

        const credits = quota?.credits || quota?.universal || { total: 0, used: 0, remaining: 0 };
        const remaining = Number(credits.remaining || 0);
        const total = Number(credits.total || 0);
        const used = Number(credits.used || 0);
        const vipBonusRemaining = Number(credits.vip_bonus?.remaining || 0);
        const remainingEl = card.querySelector('[data-user-quota-remaining]');
        const metaEl = card.querySelector('[data-user-quota-meta]');

        if (remainingEl) remainingEl.textContent = formatQuotaNumber(remaining);
        if (metaEl) {
            const parts = [
                '已用 ' + formatQuotaNumber(used),
                '总额 ' + formatQuotaNumber(total)
            ];
            if (vipBonusRemaining > 0) {
                parts.push('VIP限时 ' + formatQuotaNumber(vipBonusRemaining));
            }
            metaEl.textContent = parts.join(' · ');
        }
        card.classList.toggle('is-low', remaining <= 0);
    }

    async function refreshMenuQuota() {
        const token = getAuthToken();
        const card = getMenuQuotaCard();
        if (!token || !card) return;

        try {
            const response = await fetch(apiUrl('/api/auth/quota'), {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            if (!response.ok) throw new Error('quota request failed');
            const data = await response.json();
            renderMenuQuota(data.quota);
        } catch (error) {
            const metaEl = card.querySelector('[data-user-quota-meta]');
            if (metaEl) metaEl.textContent = '额度读取失败，点击进入用户中心查看';
        }
    }

    window.refreshMenuQuota = refreshMenuQuota;

    async function refreshCurrentUser() {
        const token = getAuthToken();
        if (!token) return;
        try {
            const response = await fetch(apiUrl('/api/auth/me'), {
                headers: { 'Authorization': 'Bearer ' + token }
            });
            if (!response.ok) return;
            const data = await response.json();
            if (data.user) {
                localStorage.setItem('aimaster_user', JSON.stringify(data.user));
                applyVipBadges(data.user);
            }
        } catch (error) {
            console.warn('刷新用户信息失败:', error.message);
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        let user = null;
        try {
            user = JSON.parse(localStorage.getItem('aimaster_user') || 'null');
        } catch (error) {
            user = null;
        }

        if (user?.role === 'admin') {
            document.querySelectorAll('[data-admin-menu-item], #adminMenuItem').forEach((item) => {
                item.style.display = '';
            });
        }
        applyVipBadges(user);
        if (user && getAuthToken()) {
            getMenuQuotaCard();
            refreshMenuQuota();
        }
        document.getElementById('userTrigger')?.addEventListener('click', () => {
            refreshMenuQuota();
        });
        refreshCurrentUser();
    });
})();
