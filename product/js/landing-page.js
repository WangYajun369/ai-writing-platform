// Navbar scroll effect
const nav = document.getElementById('nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 20);
});

// ──────────────── Share Utilities ────────────────

const PAGE_TITLE = '智写时光 TimeWrite — AI 小说写作平台';
const PAGE_DESC = '摸鱼半小时，日更万字。专为网文作者打造的桌面端 AI 写作工具，免费下载使用。';
const PAGE_URL = window.location.href;

// 检测是否在微信内置浏览器中
function isWeChat() {
  return /MicroMessenger/i.test(navigator.userAgent);
}

// Toast 提示
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

// 复制链接
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
    // 降级方案：使用 textarea 复制
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

// 分享按钮处理
function handleShare() {
  if (isWeChat()) {
    // 微信内：显示引导浮层
    document.getElementById('wxGuideOverlay').classList.add('show');
  } else if (navigator.share) {
    // 支持 Web Share API（现代浏览器 + 微信新版）
    navigator.share({
      title: PAGE_TITLE,
      text: PAGE_DESC,
      url: PAGE_URL
    }).catch(() => {
      // 用户取消分享，不做任何操作
    });
  } else {
    // 不支持分享 API：复制链接
    copyLink();
  }
}

// 绑定事件
document.addEventListener('DOMContentLoaded', () => {
  const shareBtn = document.getElementById('shareBtn');
  const copyBtn = document.getElementById('copyLinkBtn');
  const guideClose = document.getElementById('wxGuideClose');
  const guideOverlay = document.getElementById('wxGuideOverlay');

  if (shareBtn) shareBtn.addEventListener('click', handleShare);
  if (copyBtn) copyBtn.addEventListener('click', copyLink);

  // 关闭微信引导浮层
  if (guideClose) {
    guideClose.addEventListener('click', () => {
      guideOverlay.classList.remove('show');
    });
  }
  if (guideOverlay) {
    guideOverlay.addEventListener('click', (e) => {
      if (e.target === guideOverlay) {
        guideOverlay.classList.remove('show');
      }
    });
  }
});
