/**
 * AI Designer - AI智能创作平台
 * 主交互脚本 + API对接
 */

const API_BASE = window.location.protocol === 'file:' ? 'http://localhost:3000/api' : '/api';
let authToken = localStorage.getItem('aimaster_token');
let currentUser = null;
let currentToolType = null;
let currentAnnouncement = null;
const REGISTER_CODE_COOLDOWN_SECONDS = 60;
let registerCodeTimer = null;
let registerCodeCooldown = 0;

document.addEventListener('DOMContentLoaded', () => {
    initNavbar();
    initMobileMenu();
    initPricingToggle();
    initScrollAnimations();
    initSmoothScroll();
    initAuth();
    initToolCards();
    initModals();
    initAnnouncement();
    initHomeStats();
});

function initNavbar() {
    const navbar = document.getElementById('navbar');
    let lastScroll = 0;
    const scrollThreshold = 50;

    window.addEventListener('scroll', () => {
        const currentScroll = window.pageYOffset;

        if (currentScroll > scrollThreshold) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
        }

        lastScroll = currentScroll;
    }, { passive: true });
}

function initMobileMenu() {
    const menuBtn = document.getElementById('mobileMenuBtn');
    const mobileMenu = document.getElementById('mobileMenu');
    const mobileLinks = document.querySelectorAll('.mobile-nav-link');

    if (!menuBtn || !mobileMenu) return;

    menuBtn.addEventListener('click', () => {
        menuBtn.classList.toggle('active');
        mobileMenu.classList.toggle('active');
        document.body.style.overflow = mobileMenu.classList.contains('active') ? 'hidden' : '';
    });

    mobileLinks.forEach(link => {
        link.addEventListener('click', () => {
            menuBtn.classList.remove('active');
            mobileMenu.classList.remove('active');
            document.body.style.overflow = '';
        });
    });
}

function initPricingToggle() {
    const toggle = document.getElementById('pricingToggle');
    if (!toggle) return;

    toggle.addEventListener('click', () => {
        toggle.classList.toggle('active');
        const monthlyPrices = document.querySelectorAll('[data-monthly]');
        const yearlyPrices = document.querySelectorAll('[data-yearly]');

        if (toggle.classList.contains('active')) {
            monthlyPrices.forEach(el => el.style.display = 'none');
            yearlyPrices.forEach(el => el.style.display = 'inline');
        } else {
            monthlyPrices.forEach(el => el.style.display = 'inline');
            yearlyPrices.forEach(el => el.style.display = 'none');
        }
    });
}

function initScrollAnimations() {
    const observerOptions = {
        root: null,
        rootMargin: '0px',
        threshold: 0.1
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('in-view');
                observer.unobserve(entry.target);
            }
        });
    }, observerOptions);

    const animatedElements = document.querySelectorAll('.feature-card, .tool-card, .pricing-card, .section-header');
    animatedElements.forEach((el, index) => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(40px)';
        el.style.transition = `opacity 0.6s ease, transform 0.6s ease`;
        el.style.transitionDelay = `${index * 0.1}s`;
        observer.observe(el);
    });

    const style = document.createElement('style');
    style.textContent = `.in-view { opacity: 1 !important; transform: translateY(0) !important; }`;
    document.head.appendChild(style);
}

function initSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function(e) {
            e.preventDefault();
            const targetId = this.getAttribute('href');
            if (targetId === '#') return;

            const targetElement = document.querySelector(targetId);
            if (!targetElement) return;

            const headerOffset = 80;
            const elementPosition = targetElement.getBoundingClientRect().top;
            const offsetPosition = elementPosition + window.pageYOffset - headerOffset;

            window.scrollTo({ top: offsetPosition, behavior: 'smooth' });
        });
    });
}

// ============ 认证系统 ============
function initAuth() {
    const loginBtn = document.getElementById('loginBtn');
    const startBtn = document.getElementById('startBtn');
    const authModal = document.getElementById('authModal');
    const modalClose = document.getElementById('modalClose');
    const modalTabs = document.querySelectorAll('.modal-tab');
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');
    const userModal = document.getElementById('userModal');
    const userModalClose = document.getElementById('userModalClose');
    const logoutBtn = document.getElementById('logoutBtn');
    const userTrigger = document.getElementById('userTrigger');
    const userMenu = document.getElementById('userMenu');

    loginBtn?.addEventListener('click', () => openAuthModal('login'));
    startBtn?.addEventListener('click', () => openAuthModal('register'));
    
    // 用户下拉菜单头像点击
    userTrigger?.addEventListener('click', (event) => {
        event.stopPropagation();
        const isOpen = userMenu?.classList.toggle('active');
        userTrigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        if (isOpen) {
            loadUserQuota();
        }
    });

    document.addEventListener('click', (event) => {
        if (!userDropdownContains(event.target)) {
            userMenu?.classList.remove('active');
            userTrigger?.setAttribute('aria-expanded', 'false');
        }
    });

    document.querySelectorAll('.mobile-nav-actions .btn-ghost').forEach(btn => {
        btn.addEventListener('click', () => openAuthModal('login'));
    });
    document.querySelectorAll('.mobile-nav-actions .btn-primary').forEach(btn => {
        btn.addEventListener('click', () => openAuthModal('register'));
    });

    document.querySelectorAll('.pricing-card .btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.textContent.includes('免费')) {
                openAuthModal('register');
            } else {
                openAuthModal('login');
            }
        });
    });

    modalClose?.addEventListener('click', () => closeAuthModal());
    authModal?.addEventListener('click', (e) => {
        if (e.target === authModal) closeAuthModal();
    });

    modalTabs.forEach(tab => {
        tab.addEventListener('click', () => switchAuthTab(tab.dataset.tab));
    });

    loginForm?.addEventListener('submit', handleLogin);
    registerForm?.addEventListener('submit', handleRegister);
    document.getElementById('registerSendCodeBtn')?.addEventListener('click', sendRegisterCode);

    userModalClose?.addEventListener('click', () => closeUserModal());
    userModal?.addEventListener('click', (e) => {
        if (e.target === userModal) closeUserModal();
    });
    logoutBtn?.addEventListener('click', handleLogout);

    document.getElementById('loginBtn')?.addEventListener('click', function() {
        if (authToken && currentUser) {
            openUserModal();
        } else {
            openAuthModal('login');
        }
    });

    this.updateAuthUI();
}

async function updateAuthUI() {
    const loginBtn = document.getElementById('loginBtn');
    const registerBtn = document.getElementById('registerBtn');
    const userDropdown = document.getElementById('userDropdown');
    const userNavName = document.getElementById('userNavName');
    const userAvatar = document.getElementById('userAvatar');
    const userTrigger = document.getElementById('userTrigger');
    const userMenu = document.getElementById('userMenu');
    
    if (authToken && currentUser) {
        // 隐藏登录/注册按钮，显示用户下拉菜单
        loginBtn.style.display = 'none';
        registerBtn.style.display = 'none';
        userDropdown.style.display = 'flex';
        ensureUserMenuQuotaCard();
        
        // 设置导航栏用户名
        if (userNavName) {
            userNavName.textContent = currentUser.username;
        }
        
        // 设置头像首字母
        if (userAvatar) {
            userAvatar.querySelector('span').textContent = currentUser.username.charAt(0).toUpperCase();
        }
        applyVipBadges(currentUser);

        userTrigger?.setAttribute('aria-expanded', 'false');
        userMenu?.classList.remove('active');
        
        loginBtn.removeEventListener('click', () => openAuthModal('login'));
        loginBtn.addEventListener('click', openUserModal);
    } else {
        loginBtn.textContent = '登录';
        loginBtn.style.display = '';
        registerBtn.style.display = '';
        userDropdown.style.display = 'none';
        userTrigger?.setAttribute('aria-expanded', 'false');
        userMenu?.classList.remove('active');
        applyVipBadges(null);
        loginBtn.removeEventListener('click', openUserModal);
        loginBtn.addEventListener('click', () => openAuthModal('login'));
    }
}

function userDropdownContains(target) {
    const userDropdown = document.getElementById('userDropdown');
    return !!(userDropdown && target instanceof Node && userDropdown.contains(target));
}

function openAuthModal(tab = 'login') {
    const modal = document.getElementById('authModal');
    if (!modal) return;
    switchAuthTab(tab);
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeAuthModal() {
    const modal = document.getElementById('authModal');
    if (modal) modal.classList.remove('active');
    document.body.style.overflow = '';
}

function switchAuthTab(tab) {
    const modalTabs = document.querySelectorAll('.modal-tab');
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');

    modalTabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    loginForm?.classList.toggle('hidden', tab !== 'login');
    registerForm?.classList.toggle('hidden', tab !== 'register');
}

async function handleLogin(e) {
    e.preventDefault();
    const form = e.target;
    const email = form.querySelector('[name="email"]').value;
    const password = form.querySelector('[name="password"]').value;

    try {
        const res = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '登录失败');

        authToken = data.token;
        currentUser = data.user;
        localStorage.setItem('aimaster_token', authToken);
        localStorage.setItem('aimaster_user', JSON.stringify(currentUser));

        closeAuthModal();
        updateAuthUI();
        showToast('登录成功！', 'success');

        await loadUserQuota();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

async function handleRegister(e) {
    e.preventDefault();
    const form = e.target;
    const email = form.querySelector('[name="email"]').value.trim();
    const username = form.querySelector('[name="username"]').value.trim();
    const password = form.querySelector('[name="password"]').value;
    const verificationCode = form.querySelector('[name="verificationCode"]')?.value.trim();

    if (!verificationCode) {
        showToast('请先输入邮箱验证码', 'warning');
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, username, password, verificationCode })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '注册失败');

        authToken = data.token;
        currentUser = data.user;
        localStorage.setItem('aimaster_token', authToken);
        localStorage.setItem('aimaster_user', JSON.stringify(currentUser));

        closeAuthModal();
        updateAuthUI();
        showToast('注册成功！', 'success');

        await loadUserQuota();
    } catch (error) {
        showToast(error.message, 'error');
    }
}

function setRegisterCodeCooldown(seconds = REGISTER_CODE_COOLDOWN_SECONDS) {
    const btn = document.getElementById('registerSendCodeBtn');
    registerCodeCooldown = seconds;
    clearInterval(registerCodeTimer);

    const render = () => {
        if (!btn) return;
        if (registerCodeCooldown <= 0) {
            btn.disabled = false;
            btn.textContent = '发送验证码';
            clearInterval(registerCodeTimer);
            registerCodeTimer = null;
            return;
        }
        btn.disabled = true;
        btn.textContent = `${registerCodeCooldown}s后重发`;
        registerCodeCooldown -= 1;
    };

    render();
    registerCodeTimer = setInterval(render, 1000);
}

async function sendRegisterCode() {
    const email = document.getElementById('registerEmail')?.value.trim();
    const btn = document.getElementById('registerSendCodeBtn');

    if (!email) {
        showToast('请先填写邮箱', 'warning');
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.textContent = '发送中...';
    }

    try {
        const res = await fetch(`${API_BASE}/auth/send-register-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '验证码发送失败');

        showToast(data.message || '验证码已发送，请查看邮箱', 'success');
        setRegisterCodeCooldown();
    } catch (error) {
        showToast(error.message, 'error');
        if (btn) {
            btn.disabled = false;
            btn.textContent = '发送验证码';
        }
    }
}

function handleLogout() {
    authToken = null;
    currentUser = null;
    localStorage.removeItem('aimaster_token');
    localStorage.removeItem('aimaster_user');
    closeUserModal();
    updateAuthUI();
    showToast('已退出登录', 'info');
}

async function loadUserQuota() {
    if (!authToken) return;
    try {
        const res = await fetch(`${API_BASE}/auth/quota`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (res.ok) {
            const data = await res.json();
            updateQuotaUI(data.quota);
        }
    } catch (error) {
        console.error('加载额度失败:', error);
    }
}

async function refreshCurrentUser() {
    if (!authToken) return;
    try {
        const res = await fetch(`${API_BASE}/auth/me`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data.user) {
            currentUser = data.user;
            localStorage.setItem('aimaster_user', JSON.stringify(currentUser));
            updateAuthUI();
        }
    } catch (error) {
        console.error('刷新用户信息失败:', error);
    }
}

function updateQuotaUI(quota) {
    if (!quota) return;
    const q = quota.credits || quota.universal || quota.ppt;
    if (!q) return;
    const progress = q.total > 0 ? (q.used / q.total) * 100 : 0;
    const el = document.getElementById('creditQuota');
    const textEl = document.getElementById('creditQuotaText');
    if (el) el.style.width = `${Math.min(100, Math.max(0, progress))}%`;
    if (textEl) textEl.textContent = `${q.used || 0} / ${q.total || 0}，剩余 ${q.remaining || 0}`;
    updateUserMenuQuota(quota);
}

function ensureUserMenuQuotaCard() {
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

function updateUserMenuQuota(quota) {
    const card = ensureUserMenuQuotaCard();
    if (!card) return;
    const q = quota?.credits || quota?.universal || { total: 0, used: 0, remaining: 0 };
    const remaining = Number(q.remaining || 0);
    const used = Number(q.used || 0);
    const total = Number(q.total || 0);
    const vipBonusRemaining = Number(q.vip_bonus?.remaining || 0);
    const remainingEl = card.querySelector('[data-user-quota-remaining]');
    const metaEl = card.querySelector('[data-user-quota-meta]');

    if (remainingEl) remainingEl.textContent = formatQuotaNumber(remaining);
    if (metaEl) {
        const parts = [
            '已用 ' + formatQuotaNumber(used),
            '总额 ' + formatQuotaNumber(total)
        ];
        if (vipBonusRemaining > 0) parts.push('VIP限时 ' + formatQuotaNumber(vipBonusRemaining));
        metaEl.textContent = parts.join(' · ');
    }
    card.classList.toggle('is-low', remaining <= 0);
}

function isVipUser(user) {
    if (!user || (user.role !== 'vip' && !(user.role === 'admin' && user.vip_expires_at))) return false;
    if (!user.vip_expires_at) return true;
    const expiresAt = new Date(user.vip_expires_at).getTime();
    return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function applyVipBadges(user) {
    const isVip = isVipUser(user);
    document.querySelectorAll('#userAvatar, .user-avatar, .mobile-user-avatar').forEach((avatar) => {
        avatar.classList.toggle('is-vip', isVip);
    });
    document.querySelectorAll('#userInitial').forEach((initial) => {
        initial.parentElement?.classList.toggle('is-vip', isVip);
    });
}

function openUserModal() {
    const modal = document.getElementById('userModal');
    if (!modal || !currentUser) return;

    document.getElementById('userName').textContent = currentUser.username;
    document.getElementById('userEmail').textContent = currentUser.email;
    document.getElementById('userAvatar').textContent = currentUser.username.charAt(0).toUpperCase();
    document.getElementById('userAvatar').classList.toggle('is-vip', isVipUser(currentUser));

    const roleEl = document.getElementById('userRole');
    roleEl.textContent = currentUser.role === 'admin'
        ? (isVipUser(currentUser) ? '管理员 · VIP' : '管理员')
        : isVipUser(currentUser) ? 'VIP会员' : '普通用户';
    roleEl.className = `user-role role-${currentUser.role}`;

    loadUserQuota();
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeUserModal() {
    const modal = document.getElementById('userModal');
    if (modal) modal.classList.remove('active');
    document.body.style.overflow = '';
}

function getAuthHeaders() {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
    };
}

// ============ 工具卡片 ============
function initToolCards() {
    const toolCards = document.querySelectorAll('.tool-card');

    toolCards.forEach(card => {
        const btn = card.querySelector('.btn-primary');
        if (!btn) return;

        if (card.dataset.disabled === 'true' || card.classList.contains('is-disabled')) {
            btn.addEventListener('click', showVideoComingSoon);
            return;
        }

        btn.addEventListener('click', () => {
            const tool = card.dataset.tool;
            if (tool === 'video') {
                window.location.href = 'video.html';
                return;
            }
            if (!authToken) {
                showToast('请先登录后再使用', 'warning');
                openAuthModal('login');
                return;
            }
            openCreateModal(tool);
        });
    });
}

function showVideoComingSoon(event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    window.location.href = 'video.html';
    return false;
}

// ============ 创作弹窗 ============
function initModals() {
    const createModal = document.getElementById('createModal');
    const createModalClose = document.getElementById('createModalClose');
    const generateBtn = document.getElementById('generateBtn');
    const createNewBtn = document.getElementById('createNewBtn');

    createModalClose?.addEventListener('click', closeCreateModal);
    createModal?.addEventListener('click', (e) => {
        if (e.target === createModal) closeCreateModal();
    });

    generateBtn?.addEventListener('click', handleGenerate);
    createNewBtn?.addEventListener('click', () => {
        document.getElementById('createResult').classList.add('hidden');
        document.querySelector('.create-form').classList.remove('hidden');
    });
}

async function initAnnouncement() {
    const trigger = document.getElementById('noticeTrigger');
    const modal = document.getElementById('noticeModal');
    const closeBtn = document.getElementById('noticeModalClose');
    const confirmBtn = document.getElementById('noticeModalConfirm');

    closeBtn?.addEventListener('click', () => closeAnnouncementModal());
    confirmBtn?.addEventListener('click', () => closeAnnouncementModal());
    modal?.addEventListener('click', (event) => {
        if (event.target === modal) closeAnnouncementModal();
    });
    trigger?.addEventListener('click', () => openAnnouncementModal({ markSeen: false }));

    try {
        const response = await fetch(`${API_BASE}/config`, { headers: { 'Accept': 'application/json' } });
        if (!response.ok) return;

        const data = await response.json();
        const announcement = normalizeAnnouncement(data?.site?.announcement);
        if (!announcement) {
            if (trigger) trigger.style.display = 'none';
            return;
        }

        currentAnnouncement = announcement;
        if (trigger) trigger.style.display = 'inline-flex';

        const seenKey = announcementSeenKey(announcement);
        if (localStorage.getItem(seenKey) !== '1') {
            window.setTimeout(() => openAnnouncementModal({ markSeen: true }), 350);
        }
    } catch (error) {
        console.warn('公告加载失败:', error.message);
    }
}

function normalizeAnnouncement(raw) {
    if (!raw || raw.enabled !== true) return null;
    const content = String(raw.content || '').trim();
    if (!content) return null;
    return {
        title: String(raw.title || '平台公告').trim() || '平台公告',
        content
    };
}

function announcementSeenKey(announcement) {
    return `aimaster_announcement_seen_${hashText(`${announcement.title}\n${announcement.content}`)}`;
}

function hashText(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
        hash = ((hash << 5) - hash) + text.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}

function openAnnouncementModal(options = {}) {
    if (!currentAnnouncement) return;

    const modal = document.getElementById('noticeModal');
    const title = document.getElementById('noticeModalTitle');
    const body = document.getElementById('noticeModalBody');
    if (!modal || !title || !body) return;

    title.textContent = currentAnnouncement.title;
    renderAnnouncementMarkdown(body, stripDuplicateAnnouncementTitle(currentAnnouncement.content, currentAnnouncement.title));
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';

    if (options.markSeen) {
        localStorage.setItem(announcementSeenKey(currentAnnouncement), '1');
    }
}

function stripDuplicateAnnouncementTitle(content, title) {
    const normalizedTitle = String(title || '').trim();
    if (!normalizedTitle) return content;
    const headingPattern = new RegExp(`^\\s*#{1,3}\\s+${escapeRegExp(normalizedTitle)}\\s*(?:\\n+|$)`, 'i');
    return String(content || '').replace(headingPattern, '').trim();
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderAnnouncementMarkdown(container, markdown) {
    container.textContent = '';
    const fragment = document.createDocumentFragment();
    const blocks = splitMarkdownBlocks(String(markdown || ''));

    blocks.forEach(block => {
        const element = renderMarkdownBlock(block);
        if (element) fragment.appendChild(element);
    });

    container.appendChild(fragment);
}

function splitMarkdownBlocks(markdown) {
    const normalizedMarkdown = markdown
        .replace(/\r\n?/g, '\n')
        .replace(/([^\n])\s+(#{1,3}\s+)/g, '$1\n\n$2')
        .replace(/([^\n])\s+((?:[-*]|\d+[.)])\s+)/g, '$1\n$2');
    const lines = normalizedMarkdown.split('\n');
    const blocks = [];
    let paragraph = [];
    let list = null;

    const flushParagraph = () => {
        if (!paragraph.length) return;
        blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
        paragraph = [];
    };
    const flushList = () => {
        if (!list) return;
        blocks.push(list);
        list = null;
    };

    lines.forEach(line => {
        const trimmed = line.trim();
        const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
        const quoteMatch = trimmed.match(/^>\s?(.*)$/);
        const unorderedMatch = trimmed.match(/^[-*]\s+(.+)$/);
        const orderedMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);

        if (!trimmed) {
            flushParagraph();
            flushList();
            return;
        }

        if (headingMatch) {
            flushParagraph();
            flushList();
            blocks.push({ type: 'heading', level: headingMatch[1].length, text: headingMatch[2] });
            return;
        }

        if (quoteMatch) {
            flushParagraph();
            flushList();
            blocks.push({ type: 'quote', text: quoteMatch[1] });
            return;
        }

        if (unorderedMatch || orderedMatch) {
            flushParagraph();
            const ordered = Boolean(orderedMatch);
            const text = ordered ? orderedMatch[1] : unorderedMatch[1];
            if (!list || list.ordered !== ordered) {
                flushList();
                list = { type: 'list', ordered, items: [] };
            }
            list.items.push(text);
            return;
        }

        flushList();
        paragraph.push(line);
    });

    flushParagraph();
    flushList();
    return blocks;
}

function renderMarkdownBlock(block) {
    if (!block) return null;
    if (block.type === 'heading') {
        const level = Math.min(Math.max(block.level || 2, 1), 3);
        const heading = document.createElement(`h${level + 2}`);
        heading.appendChild(renderInlineMarkdown(block.text));
        return heading;
    }
    if (block.type === 'quote') {
        const quote = document.createElement('blockquote');
        quote.appendChild(renderInlineMarkdown(block.text));
        return quote;
    }
    if (block.type === 'list') {
        const list = document.createElement(block.ordered ? 'ol' : 'ul');
        block.items.forEach(item => {
            const li = document.createElement('li');
            li.appendChild(renderInlineMarkdown(item));
            list.appendChild(li);
        });
        return list;
    }
    const paragraph = document.createElement('p');
    paragraph.appendChild(renderInlineMarkdown(block.text));
    return paragraph;
}

function renderInlineMarkdown(text) {
    const fragment = document.createDocumentFragment();
    const source = String(text || '');
    const pattern = /(!)?\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(\*[^*\n]+?\*)|(\n)/g;
    let cursor = 0;
    let match;

    while ((match = pattern.exec(source)) !== null) {
        appendPlainText(fragment, source.slice(cursor, match.index));

        if (match[2] && match[3]) {
            const url = normalizeAnnouncementUrl(match[3]);
            if (url && match[1]) {
                const img = document.createElement('img');
                img.src = url;
                img.alt = match[2].slice(0, 120);
                img.loading = 'lazy';
                fragment.appendChild(img);
            } else if (url) {
                const link = document.createElement('a');
                link.href = url;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.appendChild(renderInlineMarkdown(match[2]));
                fragment.appendChild(link);
            } else {
                appendPlainText(fragment, match[0]);
            }
        } else if (match[4]) {
            const code = document.createElement('code');
            code.textContent = match[4].slice(1, -1);
            fragment.appendChild(code);
        } else if (match[5]) {
            const strong = document.createElement('strong');
            strong.appendChild(renderInlineMarkdown(match[5].slice(2, -2)));
            fragment.appendChild(strong);
        } else if (match[6]) {
            const emphasis = document.createElement('em');
            emphasis.appendChild(renderInlineMarkdown(match[6].slice(1, -1)));
            fragment.appendChild(emphasis);
        } else if (match[7]) {
            fragment.appendChild(document.createElement('br'));
        }

        cursor = pattern.lastIndex;
    }

    appendPlainText(fragment, source.slice(cursor));
    return fragment;
}

function appendPlainText(fragment, text) {
    if (text) fragment.appendChild(document.createTextNode(text));
}

function normalizeAnnouncementUrl(url) {
    const candidate = String(url || '').trim();
    if (!candidate) return '';
    if (/^(https?:)?\/\//i.test(candidate)) return candidate;
    if (candidate.startsWith('/uploads/') || candidate.startsWith('/assets/')) return candidate;
    return '';
}

function closeAnnouncementModal() {
    const modal = document.getElementById('noticeModal');
    if (!modal) return;
    modal.classList.remove('active');
    document.body.style.overflow = '';
}

function openCreateModal(type) {
    currentToolType = type;
    const modal = document.getElementById('createModal');
    const title = document.getElementById('createModalTitle');
    const prompt = document.getElementById('createPrompt');
    const options = document.getElementById('createOptions');

    const titles = {
        ppt: 'AI生成PPT',
        image: 'AI生成图片',
        video: 'AI生成视频'
    };

    const placeholders = {
        ppt: '例如：创建一个关于人工智能发展趋势的PPT，包含封面、目录、三个主要章节和总结',
        image: '例如：一只可爱的橘猫在阳光下打盹，写实风格，4K高清',
        video: '例如：展示城市天际线从日落到夜晚变化的短视频，15秒'
    };

    if (title) title.textContent = titles[type] || 'AI创作';
    if (prompt) prompt.placeholder = placeholders[type] || '';

    if (options) {
        let optionsHtml = '';
        if (type === 'image') {
            optionsHtml = `
                <div class="form-row">
                    <div class="form-group">
                        <label>图片数量</label>
                        <select id="imgCount" class="form-select">
                            <option value="1">1张</option>
                            <option value="2">2张</option>
                            <option value="4">4张</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>尺寸</label>
                        <select id="imgSize" class="form-select">
                            <option value="1024x1024">正方形 1:1</option>
                            <option value="1792x1024">宽屏 16:9</option>
                            <option value="1024x1792">竖屏 9:16</option>
                        </select>
                    </div>
                </div>
            `;
        } else if (type === 'video') {
            optionsHtml = `
                <div class="form-row">
                    <div class="form-group">
                        <label>时长</label>
                        <select id="videoDuration" class="form-select">
                            <option value="5">5秒</option>
                            <option value="10">10秒</option>
                            <option value="15">15秒</option>
                            <option value="20">20秒</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>比例</label>
                        <select id="videoRatio" class="form-select">
                            <option value="16:9">宽屏 16:9</option>
                            <option value="9:16">竖屏 9:16</option>
                            <option value="1:1">正方形 1:1</option>
                        </select>
                    </div>
                </div>
            `;
        }
        options.innerHTML = optionsHtml;
    }

    if (modal) {
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
    }
}

function closeCreateModal() {
    const modal = document.getElementById('createModal');
    if (modal) modal.classList.remove('active');
    document.body.style.overflow = '';

    document.getElementById('createPrompt').value = '';
    document.getElementById('createResult').classList.add('hidden');
    document.querySelector('.create-form').classList.remove('hidden');
    setGenerateBtnLoading(false);
}

async function handleGenerate() {
    const prompt = document.getElementById('createPrompt').value.trim();
    if (!prompt) {
        showToast('请输入创作描述', 'warning');
        return;
    }

    let params = {};
    if (currentToolType === 'image') {
        params = {
            n: parseInt(document.getElementById('imgCount')?.value || 1),
            size: document.getElementById('imgSize')?.value || '1024x1024'
        };
    } else if (currentToolType === 'video') {
        params = {
            duration: parseInt(document.getElementById('videoDuration')?.value || 10),
            aspect_ratio: document.getElementById('videoRatio')?.value || '16:9'
        };
    }

    setGenerateBtnLoading(true);

    try {
        const res = await fetch(`${API_BASE}/ai/generate/${currentToolType}`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ prompt, params })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '生成失败');

        showToast('生成成功！', 'success');
        showResult(data);

        await loadUserQuota();
    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        setGenerateBtnLoading(false);
    }
}

function setGenerateBtnLoading(loading) {
    const btn = document.getElementById('generateBtn');
    const btnText = btn.querySelector('.btn-text');
    const btnLoading = btn.querySelector('.btn-loading');
    btn.disabled = loading;
    if (btnText) btnText.classList.toggle('hidden', loading);
    if (btnLoading) btnLoading.classList.toggle('hidden', !loading);
}

function showResult(data) {
    const form = document.querySelector('.create-form');
    const resultDiv = document.getElementById('createResult');
    const contentDiv = document.getElementById('resultContent');

    form.classList.add('hidden');
    resultDiv.classList.remove('hidden');

    if (currentToolType === 'image' && data.data?.urls) {
        contentDiv.innerHTML = `
            <div class="result-images">
                ${data.data.urls.map(url => `<img src="${url}" alt="生成的图片" loading="lazy">`).join('')}
            </div>
        `;
    } else if (currentToolType === 'ppt' && data.data) {
        contentDiv.innerHTML = `
            <div class="result-ppt">
                <pre>${JSON.stringify(data.data, null, 2)}</pre>
            </div>
        `;
    } else if (currentToolType === 'video' && data.data?.url) {
        contentDiv.innerHTML = `
            <div class="result-video">
                <video src="${data.data.url}" controls></video>
            </div>
        `;
    } else {
        contentDiv.innerHTML = `<pre>${JSON.stringify(data.data || data, null, 2)}</pre>`;
    }
}

// ============ Toast 提示 ============
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <span class="toast-icon">${getToastIcon(type)}</span>
        <span class="toast-message">${message}</span>
    `;

    container.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('show'));

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function getToastIcon(type) {
    const icons = {
        success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
        error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
        warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
        info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
    };
    return icons[type] || icons.info;
}

// ============ 首页真实统计 ============
function formatHomeStatValue(value, format) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '--';

    if (format === 'percent') {
        const normalized = Math.max(0, Math.min(100, number));
        return `${Number.isInteger(normalized) ? normalized.toFixed(0) : normalized.toFixed(1)}%`;
    }

    if (number >= 1000000) {
        const valueInMillions = number / 1000000;
        return `${Number.isInteger(valueInMillions) ? valueInMillions.toFixed(0) : valueInMillions.toFixed(1)}M`;
    }

    if (number >= 10000) {
        const valueInTenThousands = number / 10000;
        return `${Number.isInteger(valueInTenThousands) ? valueInTenThousands.toFixed(0) : valueInTenThousands.toFixed(1)}万`;
    }

    return Math.round(number).toLocaleString('zh-CN');
}

function animateNumber(element, target, duration = 1200, formatter = value => Math.round(value).toLocaleString('zh-CN')) {
    const numericTarget = Number(target);
    if (!Number.isFinite(numericTarget)) {
        element.textContent = formatter(0);
        return;
    }

    const startTime = performance.now();

    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const easeProgress = 1 - Math.pow(1 - progress, 4);
        const current = easeProgress * numericTarget;

        element.textContent = formatter(current);

        if (progress < 1) {
            requestAnimationFrame(update);
        } else {
            element.textContent = formatter(numericTarget);
        }
    }

    requestAnimationFrame(update);
}

function animateHomeStatElement(element) {
    const value = Number(element.dataset.statValue);
    const format = element.dataset.statFormat || 'compact';
    animateNumber(element, value, 1200, current => formatHomeStatValue(current, format));
}

function setupHomeStatsObserver() {
    const statNumbers = document.querySelectorAll('.stat-number');
    if (!statNumbers.length) return;

    const statsObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            animateHomeStatElement(entry.target);
            statsObserver.unobserve(entry.target);
        });
    }, { threshold: 0.5 });

    statNumbers.forEach(num => statsObserver.observe(num));
}

async function initHomeStats() {
    const userEl = document.getElementById('homeUserCount');
    const workEl = document.getElementById('homeWorkCount');
    const toolCountEl = document.getElementById('homeToolCount');
    if (!userEl || !workEl || !toolCountEl) return;

    try {
        const response = await fetch(`${API_BASE}/public/stats`, { headers: { 'Accept': 'application/json' } });
        if (!response.ok) throw new Error('stats request failed');
        const data = await response.json();
        const stats = data?.stats || {};

        userEl.dataset.statValue = Number(stats.totalUsers) || 0;
        workEl.dataset.statValue = Number(stats.completedTasks) || 0;
        toolCountEl.dataset.statValue = Number(stats.toolCount) || 3;
    } catch (error) {
        console.warn('首页统计加载失败:', error.message);
        userEl.dataset.statValue = '0';
        workEl.dataset.statValue = '0';
        toolCountEl.dataset.statValue = '3';
    }

    [userEl, workEl, toolCountEl].forEach(element => {
        element.textContent = formatHomeStatValue(element.dataset.statValue, element.dataset.statFormat);
    });
    setupHomeStatsObserver();
}

// ============ 初始化用户状态 ============
if (authToken) {
    const savedUser = localStorage.getItem('aimaster_user');
    if (savedUser) {
        try {
            currentUser = JSON.parse(savedUser);
            updateAuthUI();
            loadUserQuota();
            refreshCurrentUser();
        } catch (e) {
            localStorage.removeItem('aimaster_token');
            localStorage.removeItem('aimaster_user');
            authToken = null;
        }
    }
}
