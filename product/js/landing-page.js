// ──────────────── Navbar Scroll + Hamburger ────────────────

const nav = document.getElementById('nav');
const hamburger = document.getElementById('hamburger');
const navLinks = document.getElementById('navLinks');

window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 20);
});

// Hamburger toggle
if (hamburger && navLinks) {
  hamburger.addEventListener('click', () => {
    hamburger.classList.toggle('open');
    navLinks.classList.toggle('open');
  });

  // Close mobile menu when a link is clicked
  navLinks.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      hamburger.classList.remove('open');
      navLinks.classList.remove('open');
    });
  });
}

// ──────────────── Scroll Reveal (IntersectionObserver) ────────────────

const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      revealObserver.unobserve(entry.target);
    }
  });
}, {
  threshold: 0.12,
  rootMargin: '0px 0px -40px 0px'
});

document.querySelectorAll('.reveal, .reveal-stagger').forEach(el => {
  revealObserver.observe(el);
});

// ──────────────── Nav Scrollspy ────────────────

const navLinkEls = document.querySelectorAll('.nav-links a[href^="#"]');
const navTargets = Array.from(navLinkEls)
  .map(a => document.querySelector(a.getAttribute('href')))
  .filter(Boolean);

const scrollSpyObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const id = entry.target.id;
      navLinkEls.forEach(a => {
        a.classList.toggle('active', a.getAttribute('href') === '#' + id);
      });
    }
  });
}, {
  rootMargin: '-45% 0px -50% 0px',
  threshold: 0
});

navTargets.forEach(t => scrollSpyObserver.observe(t));

// ──────────────── Stats Count-Up Animation ────────────────

function animateStat(el) {
  const text = el.textContent.trim();
  // Handle "11+", "29", "6", "8", "4", "∞"
  const match = text.match(/^(\d+)(.*)$/);
  if (!match) return; // e.g. "∞" — skip animation
  const target = parseInt(match[1], 10);
  const suffix = match[2]; // e.g. "+"
  const duration = 900;
  const startTime = performance.now();

  function tick(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
    const current = Math.round(target * eased);
    el.textContent = current + suffix;
    if (progress < 1) requestAnimationFrame(tick);
    else el.classList.add('counted');
  }
  requestAnimationFrame(tick);
}

const statsRow = document.getElementById('statsRow');
if (statsRow) {
  const statObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.querySelectorAll('.stat-value').forEach(animateStat);
        statObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.3 });
  statObserver.observe(statsRow);
}

// ──────────────── Share Utilities ────────────────

const PAGE_TITLE = '智写时光 TimeWrite — AI 小说写作平台';
const PAGE_DESC = '智写时光 TimeWrite：Rust 原生 Agent 双轨架构（画像注册表 + 流水线执行器），自动读取作品设定、多步完成大纲/润色/校验；任务卡·项目管理、英语生词本。专为网文作者打造，免费下载。';
const PAGE_URL = window.location.href;

function isWeChat() {
  return /MicroMessenger/i.test(navigator.userAgent);
}

function showToast(msg) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => toast.classList.remove('show'), 2000);
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(PAGE_URL);
    const btn = document.getElementById('copyLinkBtn');
    btn.classList.add('copied');
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> 已复制';
    showToast('链接已复制，快去分享吧！');
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg> 复制链接';
    }, 2500);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = PAGE_URL;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('链接已复制，快去分享吧！');
  }
}

function handleShare() {
  if (isWeChat()) {
    document.getElementById('wxGuideOverlay').classList.add('show');
  } else if (navigator.share) {
    navigator.share({
      title: PAGE_TITLE,
      text: PAGE_DESC,
      url: PAGE_URL
    }).catch(() => {});
  } else {
    copyLink();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const shareBtn = document.getElementById('shareBtn');
  const copyBtn = document.getElementById('copyLinkBtn');
  const guideClose = document.getElementById('wxGuideClose');
  const guideOverlay = document.getElementById('wxGuideOverlay');

  if (shareBtn) shareBtn.addEventListener('click', handleShare);
  if (copyBtn) copyBtn.addEventListener('click', copyLink);

  if (guideClose) {
    guideClose.addEventListener('click', () => guideOverlay.classList.remove('show'));
  }
  if (guideOverlay) {
    guideOverlay.addEventListener('click', (e) => {
      if (e.target === guideOverlay) guideOverlay.classList.remove('show');
    });
  }
});
