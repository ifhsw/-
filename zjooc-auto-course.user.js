// ==UserScript==
// @name         ZJOOC 自动刷课助手
// @namespace    https://www.zjooc.cn/
// @version      1.2
// @description  浙江省高等学校在线开放课程共享平台自动刷课脚本 - 自动播放、多档倍速、自动下一课
// @author       Auto
// @match        https://www.zjooc.cn/ucenter/student/course/study/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    const CONFIG = {
        speed: 1,
        speeds: [1, 1.25, 1.5, 2, 3, 4, 8, 16],
        autoNext: true,
        closeDialogs: true,
        checkInterval: 3000,
        debug: true,
    };

    function cycleSpeed() {
        const idx = CONFIG.speeds.indexOf(CONFIG.speed);
        const nextIdx = (idx + 1) % CONFIG.speeds.length;
        CONFIG.speed = CONFIG.speeds[nextIdx];
        const v = getVideo();
        if (v) v.playbackRate = CONFIG.speed;
        log('速度切换:', CONFIG.speed + 'x');
        return CONFIG.speed;
    }

    const log = (...args) => CONFIG.debug && console.log('[ZJOOC]', ...args);

    // ==================== 弹窗处理 ====================
    function closeDialogs() {
        // 移除遮罩层
        document.querySelectorAll('.v-modal').forEach(el => el.remove());
        // 隐藏对话框
        const wrappers = document.querySelectorAll('.el-dialog__wrapper');
        wrappers.forEach(el => {
            if (el.style.display !== 'none' && el.offsetParent !== null) {
                // 点击关闭按钮
                const closeBtn = el.querySelector('.el-dialog__close, .el-dialog__headerbtn');
                if (closeBtn) closeBtn.click();
                // 点击取消/确定按钮
                const footerBtns = el.querySelectorAll('.el-dialog__footer button, .el-button');
                footerBtns.forEach(btn => {
                    const t = btn.textContent.trim();
                    if (['取消', '关闭', '确定', '保存', '知道了', '知道了'].includes(t)) {
                        btn.click();
                    }
                });
            }
        });
        document.body.style.overflow = '';
    }

    // ==================== 视频控制 ====================
    function getVideo() {
        return document.querySelector('video');
    }

    function setSpeed(video, speed) {
        if (video && video.playbackRate !== speed) {
            video.playbackRate = speed;
            log('速度:', speed + 'x');
        }
    }

    function playVideo(video) {
        if (video && video.paused) {
            video.muted = true;
            video.play().catch(e => {});
            log('播放中');
        }
    }

    // ==================== 课程导航 ====================
    // 只获取侧边栏课程列表中的菜单项（排除顶部导航）
    function getLessonItems() {
        const sidebar = document.querySelector('.base-asider, .el-aside, [class*="sd-left"]');
        if (sidebar) {
            return sidebar.querySelectorAll('.el-menu-item');
        }
        // fallback: only vertical menu items
        return document.querySelectorAll('.el-menu-vertical-demo .el-menu-item');
    }

    function getCurrentLessonIndex() {
        const items = getLessonItems();
        for (let i = 0; i < items.length; i++) {
            if (items[i].classList.contains('is-active')) {
                return i;
            }
        }
        return -1;
    }

    function expandSubmenu(submenuEl) {
        if (!submenuEl) return;
        const title = submenuEl.querySelector('.el-submenu__title');
        if (title && !submenuEl.classList.contains('is-opened')) {
            title.click();
            log('展开章节');
        }
    }

    function goToNextLesson() {
        const items = getLessonItems();
        const idx = getCurrentLessonIndex();

        if (idx < 0) {
            log('未找到当前课程');
            return false;
        }

        if (idx + 1 < items.length) {
            let next = items[idx + 1];

            // 如果下一个元素不可见，说明在折叠的子菜单中
            if (next.offsetParent === null) {
                // 找到当前所在的 submenu，展开下一个 submenu
                const allSubs = document.querySelectorAll('.base-asider .el-submenu, .el-aside .el-submenu');
                for (let j = 0; j < allSubs.length; j++) {
                    if (allSubs[j].contains(items[idx])) {
                        if (j + 1 < allSubs.length) {
                            expandSubmenu(allSubs[j + 1]);
                        }
                        break;
                    }
                }
                // 等待展开后重试
                setTimeout(() => {
                    const newItems = getLessonItems();
                    const newIdx = getCurrentLessonIndex();
                    if (newIdx >= 0 && newIdx + 1 < newItems.length) {
                        const n = newItems[newIdx + 1];
                        if (n.offsetParent !== null) {
                            n.click();
                            log('下一课:', n.textContent.trim().substring(0, 50));
                        }
                    }
                }, 600);
                return true;
            }

            next.click();
            log('下一课:', next.textContent.trim().substring(0, 50));
            return true;
        }

        // 当前是最后一课
        log('已是最后一课');
        return false;
    }

    // ==================== 视频事件 ====================
    let videoEndedHandled = false;
    let currentVideoSrc = '';

    function onVideoEnded() {
        if (videoEndedHandled) return;
        videoEndedHandled = true;
        log('视频播放完毕');

        if (CONFIG.autoNext) {
            setTimeout(() => goToNextLesson(), 1500);
        }
    }

    function attachVideoListeners() {
        const video = getVideo();
        if (!video) return;

        // 同一视频不重复绑定
        if (video.src === currentVideoSrc && videoEndedHandled === false) return;
        currentVideoSrc = video.src;
        videoEndedHandled = false;

        // 移除旧事件 (通过替换)
        video.onended = null;
        video.onloadedmetadata = null;

        video.addEventListener('ended', onVideoEnded);
        video.addEventListener('loadedmetadata', () => {
            log('视频时长:', Math.floor(video.duration / 60), '分',
                Math.floor(video.duration % 60), '秒');
        });

        log('事件绑定完成');
    }

    // ==================== SPA 页面变化检测 ====================
    function onLessonChanged() {
        videoEndedHandled = false;
        currentVideoSrc = '';
        closeDialogs();
        setTimeout(attachVideoListeners, 800);
        setTimeout(() => {
            const v = getVideo();
            if (v) {
                setSpeed(v, CONFIG.speed);
                playVideo(v);
            }
        }, 1500);
    }

    // ==================== 主循环 ====================
    function tick() {
        closeDialogs();

        const video = getVideo();
        if (!video) return;

        setSpeed(video, CONFIG.speed);

        if (video.paused && !video.ended) {
            video.muted = true;
            video.play().catch(() => {});
        }

        if (video.ended && !videoEndedHandled) {
            onVideoEnded();
        }

        // 确保事件已绑定
        if (video.src !== currentVideoSrc) {
            attachVideoListeners();
        }
    }

    // ==================== 键盘快捷键 ====================
    function bindKeys() {
        document.addEventListener('keydown', (e) => {
            // 避免在输入框中触发
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            switch (e.key.toLowerCase()) {
                case 'n':
                    if (e.ctrlKey) {
                        e.preventDefault();
                        goToNextLesson();
                    }
                    break;
                case 's':
                    if (e.ctrlKey) {
                        e.preventDefault();
                        cycleSpeed();
                    }
                    break;
                case 'd':
                    if (e.ctrlKey) {
                        e.preventDefault();
                        const v = getVideo();
                        if (v) {
                            v.muted = !v.muted;
                            log('静音:', v.muted);
                        }
                    }
                    break;
                case 'arrowright':
                    if (e.ctrlKey) {
                        e.preventDefault();
                        const v = getVideo();
                        if (v) v.currentTime += 10;
                    }
                    break;
                case 'arrowleft':
                    if (e.ctrlKey) {
                        e.preventDefault();
                        const v = getVideo();
                        if (v) v.currentTime -= 10;
                    }
                    break;
            }
        });
    }

    // ==================== UI 面板 (可选) ====================
    function createPanel() {
        const panel = document.createElement('div');
        panel.id = 'zjooc-panel';
        panel.innerHTML = `
            <style>
                #zjooc-panel {
                    position: fixed;
                    top: 60px;
                    right: 10px;
                    z-index: 99999;
                    background: rgba(0,0,0,0.85);
                    color: #0f0;
                    padding: 10px 14px;
                    border-radius: 6px;
                    font-size: 12px;
                    font-family: monospace;
                    line-height: 1.6;
                }
                #zjooc-panel span { color: #ff0; }
                #zjooc-panel button {
                    display: block;
                    margin: 4px 0;
                    padding: 4px 8px;
                    font-size: 11px;
                    cursor: pointer;
                    background: #333;
                    color: #0f0;
                    border: 1px solid #0f0;
                    border-radius: 3px;
                }
                #zjooc-panel button:hover { background: #0f0; color: #000; }
            </style>
            <div>🔧 ZJOOC 刷课助手</div>
            <div>速度: <span id="zp-speed">${CONFIG.speed}x</span></div>
            <div>状态: <span id="zp-status">运行中</span></div>
            <button id="zp-btn-speed">切换速度 (${CONFIG.speeds.join('x/')}x)</button>
            <button id="zp-btn-next">下一课 ▶▶</button>
            <button id="zp-btn-mute">切换静音</button>
        `;
        document.body.appendChild(panel);

        document.getElementById('zp-btn-speed').onclick = () => {
            const newSpeed = cycleSpeed();
            document.getElementById('zp-speed').textContent = newSpeed + 'x';
        };
        document.getElementById('zp-btn-next').onclick = goToNextLesson;
        document.getElementById('zp-btn-mute').onclick = () => {
            const v = getVideo();
            if (v) { v.muted = !v.muted; }
        };

        // 更新状态
        setInterval(() => {
            const v = getVideo();
            const statusEl = document.getElementById('zp-status');
            const speedEl = document.getElementById('zp-speed');
            if (v && statusEl) {
                const remaining = v.duration - v.currentTime;
                const actualSpeed = v.playbackRate;
                const realRemaining = remaining / actualSpeed;
                statusEl.textContent = v.paused ? '已暂停' :
                    v.ended ? '已结束' :
                    `剩余 ${Math.floor(realRemaining / 60)}分${Math.floor(realRemaining % 60)}秒`;
                if (speedEl) speedEl.textContent = actualSpeed + 'x';
            }
        }, 1000);
    }

    // ==================== 启动 ====================
    function init() {
        log('ZJOOC 自动刷课脚本 v1.2 启动');

        closeDialogs();
        bindKeys();
        createPanel();

        setTimeout(attachVideoListeners, 800);
        setTimeout(() => {
            const v = getVideo();
            if (v) { setSpeed(v, CONFIG.speed); playVideo(v); }
        }, 1500);

        setInterval(tick, CONFIG.checkInterval);

        // SPA 路由监听
        let lastUrl = location.href;
        setInterval(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                log('页面切换');
                onLessonChanged();
            }
        }, 1000);

        log('初始化完成 | 快捷键: Ctrl+S=切速度 Ctrl+N=下一课 Ctrl+D=切静音');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
