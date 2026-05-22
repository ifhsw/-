// ==UserScript==
// @name         ZJOOC 自动刷课助手
// @namespace    https://www.zjooc.cn/
// @version      2.0
// @description  浙江省高等学校在线开放课程共享平台自动刷课脚本 - 多tab处理、完成验证、可跳过文件型课时
// @author       Auto
// @match        https://www.zjooc.cn/ucenter/student/course/study/*
// @grant        GM_xmlhttpRequest
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
        fileViewMinTime: 15,
        skipFileLessons: false,
        autoScrollFile: true,
        fileScrollInterval: 2000,
        completeRetryDelay: 2000,
        maxCompleteRetries: 3,
    };

    const log = (...args) => CONFIG.debug && console.log('[ZJOOC]', ...args);

    // ==================== AI 答题配置 ====================
    const AI_CONFIG = {
        apiUrl: '',
        apiKey: '',
        model: 'gpt-4o',
        batchSize: 5,
    };

    (function() {
        try {
            let saved = localStorage.getItem('zjooc-ai-config');
            if (saved) {
                const p = JSON.parse(saved);
                if (p.apiUrl) AI_CONFIG.apiUrl = p.apiUrl;
                if (p.model) AI_CONFIG.model = p.model;
                if (p.batchSize) AI_CONFIG.batchSize = p.batchSize;
                // 清除已存储的API Key
                if (p.apiKey) {
                    delete p.apiKey;
                    localStorage.setItem('zjooc-ai-config', JSON.stringify(p));
                }
            }
        } catch(e) {}
    })();

    function saveAIConfig() {
        try {
            localStorage.setItem('zjooc-ai-config', JSON.stringify({
                apiUrl: AI_CONFIG.apiUrl,
                model: AI_CONFIG.model,
                batchSize: AI_CONFIG.batchSize,
            }));
        } catch(e) {}
    }

    // ==================== AI 答题模块 ====================
    function isHomeworkPage() {
        return /\/homework\/do\//.test(location.href);
    }

    function isQuestionAnswered(qEl) {
        const inputs = qEl.querySelectorAll('input[type="radio"], input[type="checkbox"]');
        for (const inp of inputs) {
            if (inp.checked) return true;
        }
        return false;
    }

    function extractAllQuestions() {
        const items = document.querySelectorAll('.questiono-item');
        const questions = [];
        let currentType = 'single';

        // 通过遍历所有节点确定每道题的题型
        const container = items.length > 0 ? items[0].closest('.common_look_main, .el-row') : null;
        if (container) {
            const children = container.querySelectorAll('.el-col-24[style*="padding"], .questiono-item, .common-question .questiono-item');
            children.forEach(el => {
                const text = el.textContent.trim();
                if (text.includes('单选题')) currentType = 'single';
                else if (text.includes('多选题')) currentType = 'multiple';
                else if (text.includes('判断题')) currentType = 'judge';
                else if (el.classList.contains('questiono-item')) {
                    const qEl = el.querySelector('.questiono-header .processing_img');
                    const qText = qEl ? qEl.textContent.trim() : '';
                    const qNum = el.querySelector('.questiono-header b');
                    const qNumText = qNum ? qNum.textContent.trim().replace('.', '') : '';

                    const options = [];
                    const radioInputs = el.querySelectorAll('input[type="radio"]');
                    const checkboxInputs = el.querySelectorAll('input[type="checkbox"]');

                    if (checkboxInputs.length > 0) {
                        const labels = el.querySelectorAll('.el-checkbox__label .processing_img');
                        checkboxInputs.forEach((cb, idx) => {
                            options.push({
                                value: cb.value || String.fromCharCode(65 + idx),
                                text: labels[idx] ? labels[idx].textContent.trim() : '',
                            });
                        });
                    } else {
                        const labels = el.querySelectorAll('.el-radio__label .processing_img');
                        radioInputs.forEach((radio, idx) => {
                            // 判断题的DOM值是yes/no，需要映射为A/B给AI
                            const domValue = radio.value || '';
                            const isJudge = currentType === 'judge';
                            options.push({
                                value: isJudge ? String.fromCharCode(65 + idx) : (radio.value || String.fromCharCode(65 + idx)),
                                domValue: isJudge ? domValue : null,
                                text: labels[idx] ? labels[idx].textContent.trim() : '',
                            });
                        });
                    }

                    questions.push({
                        index: questions.length,
                        number: qNumText || String(questions.length + 1),
                        type: currentType,
                        text: qText,
                        options: options,
                        element: el,
                    });
                }
            });
        }

        return questions;
    }

    function buildPrompt(questions) {
        const typeNames = { single: '单选题', multiple: '多选题', judge: '判断题' };
        let prompt = '你是课程测验答题助手。请回答以下题目，只返回JSON格式结果，不要任何解释。\n\n';

        questions.forEach((q, i) => {
            prompt += `${i + 1}. [${typeNames[q.type] || '未知'}] ${q.text}\n`;
            q.options.forEach(o => {
                prompt += `   ${o.value}. ${o.text}\n`;
            });
            prompt += '\n';
        });

        prompt += '返回格式（严格按此JSON，不要markdown包裹）：\n{"answers": [\n';
        prompt += '    {"index": 0, "answer": "C"},\n';
        prompt += '    {"index": 1, "answer": ["A", "C"]}\n';
        prompt += '  ]}\n';
        prompt += '规则：\n';
        prompt += '- 单选题answer为单个大写字母如"C"\n';
        prompt += '- 多选题answer为字母数组如["A","C"]\n';
        prompt += '- 判断题answer为正确选项的大写字母\n';
        prompt += '- index从0开始\n';
        prompt += '- 只返回纯JSON，不要```json标记，不要任何解释文字';
        return prompt;
    }

    function isAnthropicURL() {
        return /anthropic|claude/i.test(AI_CONFIG.apiUrl);
    }

    function getAPIUrl() {
        let url = AI_CONFIG.apiUrl.replace(/\/+$/, '');
        if (isAnthropicURL() && !url.endsWith('/messages')) {
            url += '/messages';
        }
        return url;
    }

    function apiRequest(body, isTest = false) {
        const isAnthropic = isAnthropicURL();
        const apiUrl = getAPIUrl();
        return new Promise((resolve, reject) => {
            const headers = { 'Content-Type': 'application/json' };
            if (isAnthropic) {
                headers['x-api-key'] = AI_CONFIG.apiKey;
            } else {
                headers['Authorization'] = 'Bearer ' + AI_CONFIG.apiKey;
            }

            if (typeof GM_xmlhttpRequest !== 'undefined') {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: apiUrl,
                    headers: headers,
                    data: body,
                    onload: function(resp) {
                        const rawText = resp.responseText || resp.response || resp.responseBody || '';
                        log('API状态:', resp.status, '响应长度:', rawText.length);
                        log('resp keys:', Object.keys(resp).join(','));
                        if (rawText.length > 0) log('API原始:', rawText.substring(0, 400));
                        if (rawText.length === 0) {
                            reject(new Error('服务器返回空 (' + resp.status + ')，请检查API URL是否正确'));
                            return;
                        }
                        try {
                            const data = JSON.parse(rawText);

                            if (data.error) {
                                reject(new Error('API错误: ' + (data.error.message || JSON.stringify(data.error))));
                                return;
                            }

                            let content = '';
                            if (data.choices && data.choices[0]) {
                                content = data.choices[0].message?.content || data.choices[0].text || '';
                            }
                            // 兼容 Anthropic 格式
                            if (!content && data.content) {
                                const textBlock = data.content.find(c => c.type === 'text');
                                content = textBlock?.text || data.content[0]?.text || '';
                            }

                            if (!content && !isTest) {
                                log('无法提取内容，data keys:', Object.keys(data));
                                log('data sample:', rawText.substring(0, 400));
                            }

                            resolve({ content, status: resp.status, data });
                        } catch(e) {
                            if (!isTest) log('原始响应:', rawText.substring(0, 300));
                            reject(new Error('响应解析失败: ' + e.message + (rawText ? ' | 返回: ' + rawText.substring(0, 100) : '')));
                        }
                    },
                    onerror: function() {
                        reject(new Error('网络请求失败，请检查API URL'));
                    },
                    ontimeout: function() {
                        reject(new Error('请求超时'));
                    },
                });
            } else {
                fetch(apiUrl, {
                    method: 'POST',
                    headers: headers,
                    body: body,
                }).then(r => r.json()).then(data => {
                    let content = '';
                    if (data.choices && data.choices[0]) {
                        content = data.choices[0].message?.content || data.choices[0].text || '';
                    }
                    if (!content && data.content) {
                        const textBlock = data.content.find(c => c.type === 'text');
                        content = textBlock?.text || data.content[0]?.text || '';
                    }
                    resolve({ content, status: 200, data });
                }).catch(reject);
            }
        });
    }

    function callAI(questionsBatch) {
        const prompt = buildPrompt(questionsBatch);
        const isAnthropic = isAnthropicURL();
        const body = isAnthropic
            ? JSON.stringify({
                model: AI_CONFIG.model,
                system: '你是一个精确的答题助手。只返回要求的JSON格式。',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.1,
                max_tokens: 4000,
            })
            : JSON.stringify({
                model: AI_CONFIG.model,
                messages: [
                    { role: 'system', content: '你是一个精确的答题助手。只返回要求的JSON格式。' },
                    { role: 'user', content: prompt },
                ],
                temperature: 0.1,
                max_tokens: 4000,
            });
        return apiRequest(body).then(r => r.content);
    }

    async function testAPIConnection() {
        updateAIStatus('测试连接中...', '#ff0');
        try {
            const body = JSON.stringify({
                model: AI_CONFIG.model,
                messages: [{ role: 'user', content: '回复OK' }],
                max_tokens: 10,
            });
            const result = await apiRequest(body, true);
            if (result.content && result.content.length > 0) {
                updateAIStatus('连接成功! (' + result.status + ')', '#0f0');
                log('API连接测试成功, status:', result.status);
                return true;
            } else {
                updateAIStatus('连接异常: 回复为空', '#f90');
                return false;
            }
        } catch(e) {
            updateAIStatus('连接失败: ' + e.message, '#f00');
            log('API连接测试失败:', e.message);
            return false;
        }
    }

    function parseAIResponse(responseText) {
        let text = responseText.trim();

        // 去掉 markdown 代码块
        const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlockMatch) text = codeBlockMatch[1].trim();

        // 尝试提取JSON对象
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                const data = JSON.parse(jsonMatch[0]);
                if (data.answers && Array.isArray(data.answers)) {
                    return data.answers;
                }
            } catch(e) {
                log('JSON解析失败:', e.message);
            }
        }

        // 后备: 尝试直接在文本中找答案字母
        // 格式: "1. C" 或 "1: C" 或 "第1题: C"
        log('尝试从文本中提取答案...');
        const fallback = [];
        const lines = responseText.split('\n');
        for (const line of lines) {
            const m = line.match(/(\d+)[\.\)、:：]\s*([A-D]+)/i);
            if (m) {
                fallback.push({ index: parseInt(m[1]) - 1, answer: m[2].toUpperCase() });
            }
        }
        if (fallback.length > 0) {
            log('后备解析得到', fallback.length, '个答案');
            return fallback;
        }

        return null;
    }

    function findInputByValue(el, ans, type) {
        // 大小写不敏感匹配
        const upper = ans.toUpperCase();
        const lower = ans.toLowerCase();
        const selector = type === 'checkbox'
            ? 'input[type="checkbox"]'
            : 'input[type="radio"]';
        const inputs = el.querySelectorAll(selector);
        for (const inp of inputs) {
            if (inp.value.toUpperCase() === upper || inp.value === lower || inp.value === ans) {
                return inp;
            }
        }
        return null;
    }

    async function fillAnswer(question, answer) {
        const el = question.element;
        let clicked = false;

        if (question.type === 'multiple') {
            let ansArray = [];
            if (Array.isArray(answer)) {
                ansArray = answer;
            } else if (typeof answer === 'string') {
                if (/^[A-Da-d]+$/.test(answer.trim())) {
                    ansArray = answer.trim().split('');
                } else if (answer.includes(',')) {
                    ansArray = answer.split(',').map(s => s.trim());
                } else {
                    ansArray = [answer.trim()];
                }
            }

            const selectedTexts = [];
            for (const ans of ansArray) {
                if (typeof ans !== 'string') continue;
                const cb = findInputByValue(el, ans, 'checkbox');
                if (!cb) { selectedTexts.push(ans + '?'); continue; }
                const label = cb.closest('label');
                if (!label) continue;

                if (!cb.checked) {
                    label.click();
                    await new Promise(r => setTimeout(r, 80));
                }
                clicked = true;
                selectedTexts.push(ans + '✓');
            }
            log('多选填充', question.number, ':', selectedTexts.join(', '));
        } else {
            // 单选/判断
            const ans = Array.isArray(answer) ? answer[0] : answer;
            if (typeof ans === 'string') {
                let searchValue = ans;
                const matchedOption = question.options.find(o => o.value.toUpperCase() === ans.toUpperCase());
                if (matchedOption && matchedOption.domValue) {
                    searchValue = matchedOption.domValue;
                }

                const radio = findInputByValue(el, searchValue, 'radio');
                if (radio) {
                    const label = radio.closest('label');
                    if (label) {
                        label.click();
                        clicked = true;
                        log('填充', question.number, ':', ans,
                            matchedOption?.text || '');
                    }
                } else {
                    log('未找到选项:', ans, '(搜索值:', searchValue + ') 题目:', question.text.substring(0, 30));
                }
            }
        }

        // 视觉反馈
        const header = el.querySelector('.questiono-header');
        if (header) {
            header.style.borderLeft = clicked ? '3px solid #0f0' : '3px solid #f90';
            header.style.paddingLeft = '5px';
        }

        return clicked;
    }

    let aiAnswering = false;
    let aiAnsweredCount = 0;
    let aiTotalCount = 0;

    async function runAIAnswer() {
        if (aiAnswering) {
            log('AI答题正在进行中');
            return;
        }

        if (!AI_CONFIG.apiKey) {
            alert('请先在控制面板中设置API Key');
            return;
        }

        const allQuestions = extractAllQuestions();
        if (allQuestions.length === 0) {
            log('未检测到题目');
            updateAIStatus('未检测到题目', '#f90');
            return;
        }

        // 跳过已答题目
        const unanswered = [];
        const alreadyAnswered = [];
        allQuestions.forEach(q => {
            if (isQuestionAnswered(q.element)) {
                alreadyAnswered.push(q);
            } else {
                unanswered.push(q);
            }
        });

        if (alreadyAnswered.length > 0) {
            log('已跳过', alreadyAnswered.length, '道已答题，剩余', unanswered.length, '道');
        }

        if (unanswered.length === 0) {
            updateAIStatus('全部已完成!', '#0f0');
            log('所有题目已答完');
            return;
        }

        aiAnswering = true;
        aiTotalCount = allQuestions.length;
        aiAnsweredCount = alreadyAnswered.length;
        updateAIProgress();

        log('AI答题开始，未答', unanswered.length, '题 (共', aiTotalCount, '题)');
        updateAIStatus('答题中...', '#ff0');

        // 分批处理 (带重试)
        const MAX_RETRIES = 3;
        const RETRY_DELAY = 2000;

        for (let i = 0; i < unanswered.length; i += AI_CONFIG.batchSize) {
            const batch = unanswered.slice(i, i + AI_CONFIG.batchSize);
            const batchNum = Math.floor(i / AI_CONFIG.batchSize) + 1;
            let success = false;

            for (let retry = 0; retry < MAX_RETRIES; retry++) {
                try {
                    if (retry > 0) {
                        log('批次', batchNum, '重试', retry + '/' + MAX_RETRIES);
                        updateAIStatus('重试批次' + batchNum + ' (' + (retry + 1) + '/' + MAX_RETRIES + ')', '#ff0');
                        await new Promise(r => setTimeout(r, RETRY_DELAY));
                    } else {
                        log('批次', batchNum, '请求中...');
                    }

                    const response = await callAI(batch);
                    log('AI回复:', response.substring(0, 300));
                    const answers = parseAIResponse(response, batch.length);

                    if (answers) {
                        log('解析到', answers.length, '个答案');
                        for (const a of answers) {
                            const globalIdx = i + a.index;
                            const q = unanswered[globalIdx];
                            if (q) {
                                const ok = await fillAnswer(q, a.answer);
                                if (ok) aiAnsweredCount++;
                            }
                        }
                        success = true;
                        break;
                    } else {
                        log('批次', batchNum, '解析失败');
                        if (retry < MAX_RETRIES - 1) {
                            updateAIStatus('解析失败，重试中...', '#f90');
                        }
                    }
                } catch(e) {
                    log('批次', batchNum, '请求出错:', e.message);
                    if (retry < MAX_RETRIES - 1) {
                        updateAIStatus('网络错误，' + (retry + 2) + '秒后重试...', '#f90');
                    }
                }
            }

            if (!success) {
                updateAIStatus('批次' + batchNum + '失败(已重试' + MAX_RETRIES + '次)，继续下一批', '#f90');
                log('批次', batchNum, '最终失败，跳过');
            }

            updateAIProgress();

            if (i + AI_CONFIG.batchSize < unanswered.length) {
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        aiAnswering = false;
        updateAIStatus('完成! 已答' + aiAnsweredCount + '/' + aiTotalCount + '题', '#0f0');
        log('AI答题完成，已答', aiAnsweredCount, '/', aiTotalCount);
    }

    function updateAIProgress() {
        const el = document.getElementById('zp-ai-progress');
        if (el) el.textContent = aiAnsweredCount + '/' + aiTotalCount;
    }

    function updateAIStatus(msg, color) {
        const el = document.getElementById('zp-ai-status');
        if (el) {
            el.textContent = msg;
            if (color) el.style.color = color;
        }
    }

    // ==================== 弹窗处理 ====================
    function closeDialogs() {
        document.querySelectorAll('.v-modal').forEach(el => el.remove());
        const wrappers = document.querySelectorAll('.el-dialog__wrapper');
        wrappers.forEach(el => {
            if (el.style.display !== 'none' && el.offsetParent !== null) {
                const closeBtn = el.querySelector('.el-dialog__close, .el-dialog__headerbtn');
                if (closeBtn) closeBtn.click();
                const footerBtns = el.querySelectorAll('.el-dialog__footer button, .el-button');
                footerBtns.forEach(btn => {
                    const t = btn.textContent.trim();
                    if (['取消', '关闭', '确定', '保存', '知道了'].includes(t)) {
                        btn.click();
                    }
                });
            }
        });
        document.body.style.overflow = '';
    }

    // ==================== Tab 结构 (课时内多tab) ====================
    function getContentTabs() {
        const tabs = document.querySelectorAll('.plan-detailvideo .el-tabs__item');
        return Array.from(tabs).filter(t => t.id && t.id.startsWith('tab-'));
    }

    function getCurrentTabIndex() {
        const tabs = getContentTabs();
        for (let i = 0; i < tabs.length; i++) {
            if (tabs[i].classList.contains('is-active')) return i;
        }
        return -1;
    }

    function getActiveTabPane() {
        const tabs = getContentTabs();
        for (const tab of tabs) {
            if (tab.classList.contains('is-active')) {
                const paneId = tab.id.replace('tab-', 'pane-');
                return document.getElementById(paneId);
            }
        }
        return null;
    }

    function switchToTab(tabEl) {
        if (!tabEl || tabEl.classList.contains('is-active')) return false;
        tabEl.click();
        log('切换到 tab:', tabEl.textContent.trim().substring(0, 40));
        return true;
    }

    // ==================== 完成学习按钮 ====================
    function findCompleteButton() {
        // 查找所有可见的包含"完成学习"的按钮
        const btns = document.querySelectorAll('.el-button');
        for (const btn of btns) {
            if (btn.textContent.includes('完成学习') && btn.offsetParent !== null) {
                return btn;
            }
        }
        return null;
    }

    function isCompleteButtonDisabled() {
        const btn = findCompleteButton();
        if (!btn) return true; // 没有按钮视为已完成
        return btn.classList.contains('is-disabled') || btn.disabled;
    }

    function clickCompleteButton() {
        const btn = findCompleteButton();
        if (!btn) {
            log('未找到"完成学习"按钮');
            return false;
        }
        if (btn.classList.contains('is-disabled') || btn.disabled) {
            log('"完成学习"已是完成状态');
            return true;
        }
        btn.click();
        log('已点击"完成学习"');
        return true;
    }

    // ==================== 课时内tab类型判断 ====================
    function getTabType(paneEl) {
        if (!paneEl) return 'unknown';
        if (paneEl.querySelector('video')) return 'video';
        if (paneEl.querySelector('iframe')) return 'file';
        if (paneEl.querySelector('.contain-video')) return 'video';
        if (paneEl.querySelector('.contain-item-main')) return 'file';
        if (paneEl.querySelector('.contain-bottom')) return 'file';
        return 'unknown';
    }

    // ==================== 视频控制 ====================
    function getVideo() {
        const pane = getActiveTabPane();
        if (pane) {
            const v = pane.querySelector('video');
            if (v) return v;
        }
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

    function cycleSpeed() {
        const idx = CONFIG.speeds.indexOf(CONFIG.speed);
        const nextIdx = (idx + 1) % CONFIG.speeds.length;
        CONFIG.speed = CONFIG.speeds[nextIdx];
        const v = getVideo();
        if (v) v.playbackRate = CONFIG.speed;
        log('速度切换:', CONFIG.speed + 'x');
        return CONFIG.speed;
    }

    // ==================== 文件型课时 ====================
    let fileViewStartTime = null;
    let fileViewCompleted = false;

    function isFileLesson() {
        const pane = getActiveTabPane();
        if (pane && getTabType(pane) === 'file') return true;
        // fallback
        if (getVideo()) return false;
        const iframe = document.querySelector('iframe[src*="pdf"], iframe[src*="doc"], iframe[src*="viewer"], iframe[src*="file"], iframe[src*="office"]');
        if (iframe) return true;
        const embed = document.querySelector('embed, object');
        if (embed) return true;
        return false;
    }

    function getFileInfo() {
        const iframe = document.querySelector('iframe');
        if (iframe) return { type: 'iframe', src: iframe.src };
        const embed = document.querySelector('embed, object');
        if (embed) return { type: embed.tagName.toLowerCase(), src: embed.src || embed.data };
        return { type: 'unknown', src: '' };
    }

    function resetFileTimer() {
        fileViewStartTime = Date.now();
        fileViewCompleted = false;
        log('文件课时开始计时，最低观看:', CONFIG.fileViewMinTime, '秒');
    }

    function handleFileLesson() {
        if (fileViewCompleted) return;
        if (!fileViewStartTime) resetFileTimer();

        const elapsed = (Date.now() - fileViewStartTime) / 1000;

        if (CONFIG.autoScrollFile) {
            const iframe = document.querySelector('iframe');
            if (iframe) {
                try {
                    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                    if (iframeDoc) {
                        const maxScroll = iframeDoc.documentElement.scrollHeight - iframeDoc.documentElement.clientHeight;
                        if (maxScroll > 0) {
                            const target = Math.min(maxScroll, (elapsed / CONFIG.fileViewMinTime) * maxScroll);
                            iframeDoc.documentElement.scrollTop = target;
                        }
                    }
                } catch (e) {}
            }
            const mainScroll = document.documentElement;
            const pageMax = mainScroll.scrollHeight - mainScroll.clientHeight;
            if (pageMax > 0) {
                const target = Math.min(pageMax, (elapsed / CONFIG.fileViewMinTime) * pageMax);
                mainScroll.scrollTop = target;
            }
        }

        if (elapsed >= CONFIG.fileViewMinTime) {
            fileViewCompleted = true;
            log('文件课时观看计时完成');
            onFileTimerDone();
        }
    }

    function onFileTimerDone() {
        if (CONFIG.skipFileLessons) {
            log('文件型课时已跳过');
            onCurrentTabComplete();
        } else {
            // "完成学习"在文件tab计时完成后点击
            if (clickCompleteButton()) {
                setTimeout(() => {
                    if (isCompleteButtonDisabled()) {
                        log('文件课时: "完成学习"已确认');
                        onCurrentTabComplete();
                    }
                }, 1500);
            }
        }
    }

    function skipCurrentFile() {
        if (!isFileLesson()) {
            log('当前不是文件型课时');
            return;
        }
        log('手动跳过文件课时');
        fileViewCompleted = true;
        onFileTimerDone();
    }

    // ==================== 当前tab完成 → 下一个tab或下一课 ====================
    function onCurrentTabComplete() {
        const tabs = getContentTabs();
        const currentIdx = getCurrentTabIndex();

        if (tabs.length === 0) {
            log('无内容tab，跳下一课');
            goToNextLesson();
            return;
        }

        // 如果有更多tab，切换到下一个
        if (currentIdx >= 0 && currentIdx + 1 < tabs.length) {
            const nextTab = tabs[currentIdx + 1];
            log('当前tab完成，切换到下一个tab:', nextTab.textContent.trim().substring(0, 40));
            resetTabState();
            switchToTab(nextTab);
            setTimeout(() => {
                const v = getVideo();
                if (v) { setSpeed(v, CONFIG.speed); playVideo(v); }
                if (isFileLesson()) resetFileTimer();
            }, 1000);
            return;
        }

        // 所有tab都完成了，进入下一课
        log('所有tab完成，进入下一课');
        goToNextLesson();
    }

    function resetTabState() {
        fileViewStartTime = null;
        fileViewCompleted = false;
        videoEndedHandled = false;
        currentVideoSrc = '';
    }

    // ==================== 课程导航 ====================
    function getLessonItems() {
        const sidebar = document.querySelector('.base-asider, .el-aside, [class*="sd-left"]');
        if (sidebar) {
            return sidebar.querySelectorAll('.el-menu-item');
        }
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

            if (next.offsetParent === null) {
                const allSubs = document.querySelectorAll('.base-asider .el-submenu, .el-aside .el-submenu');
                for (let j = 0; j < allSubs.length; j++) {
                    if (allSubs[j].contains(items[idx])) {
                        if (j + 1 < allSubs.length) {
                            expandSubmenu(allSubs[j + 1]);
                        }
                        break;
                    }
                }
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

        // 视频完成后，检查是否有"完成学习"按钮需要点击
        setTimeout(() => {
            const btn = findCompleteButton();
            if (btn && !isCompleteButtonDisabled()) {
                log('视频完成，点击"完成学习"');
                clickCompleteButton();
                setTimeout(() => {
                    if (isCompleteButtonDisabled()) {
                        log('视频课时: "完成学习"已确认');
                        onCurrentTabComplete();
                    }
                }, 1500);
            } else {
                // 无按钮或以完成，直接进入下一个tab
                onCurrentTabComplete();
            }
        }, 2000);
    }

    function attachVideoListeners() {
        const video = getVideo();
        if (!video) return;

        if (video.src === currentVideoSrc && videoEndedHandled === false) return;
        currentVideoSrc = video.src;
        videoEndedHandled = false;

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
        resetTabState();
        closeDialogs();
        setTimeout(attachVideoListeners, 800);
        setTimeout(() => {
            const v = getVideo();
            if (v) {
                setSpeed(v, CONFIG.speed);
                playVideo(v);
            } else if (isFileLesson()) {
                resetFileTimer();
            }
        }, 1500);
    }

    // ==================== 主循环 ====================
    function tick() {
        closeDialogs();

        const video = getVideo();
        const pane = getActiveTabPane();
        const tabType = getTabType(pane);

        if (video && tabType === 'video') {
            // 视频型 tab
            setSpeed(video, CONFIG.speed);

            if (video.paused && !video.ended) {
                video.muted = true;
                video.play().catch(() => {});
            }

            if (video.ended && !videoEndedHandled) {
                onVideoEnded();
            }

            if (video.src !== currentVideoSrc) {
                attachVideoListeners();
            }
        } else if (tabType === 'file' || isFileLesson()) {
            // 文件型 tab
            handleFileLesson();
        }
    }

    // ==================== 键盘快捷键 ====================
    function bindKeys() {
        document.addEventListener('keydown', (e) => {
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
                case 'f':
                    if (e.ctrlKey) {
                        e.preventDefault();
                        skipCurrentFile();
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
                case 'q':
                    if (e.ctrlKey) {
                        e.preventDefault();
                        if (isHomeworkPage()) {
                            runAIAnswer();
                        } else {
                            log('当前不在作业页面，Ctrl+Q无效');
                        }
                    }
                    break;
            }
        });
    }

    // ==================== UI 面板 ====================
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
                    max-width: 220px;
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
                #zjooc-panel button.skip-btn { border-color: #f90; color: #f90; }
                #zjooc-panel button.skip-btn:hover { background: #f90; color: #000; }
            </style>
            <div>ZJOOC 刷课助手 v2.0</div>
            <div>倍速: <span id="zp-speed">${CONFIG.speed}x</span></div>
            <div>Tab: <span id="zp-tab">-</span></div>
            <div>状态: <span id="zp-status">运行中</span></div>
            <button id="zp-btn-speed">切换倍速 (${CONFIG.speeds.join('x/')}x)</button>
            <button id="zp-btn-skip">跳过当前文件 (Ctrl+F)</button>
            <button id="zp-btn-next">下一课 (Ctrl+N)</button>
            <button id="zp-btn-mute">切换静音 (Ctrl+D)</button>
            <div style="margin-top:8px;border-top:1px solid #0f0;padding-top:6px;">
                <div id="zp-ai-toggle" style="cursor:pointer;color:#0ff;">AI答题 [展开]</div>
                <div id="zp-ai-config" style="display:none;margin-top:4px;">
                    <div style="font-size:10px;color:#999;">API URL:</div>
                    <input id="zp-api-url" style="width:100%;background:#222;color:#0f0;border:1px solid #0f0;font-size:10px;margin:2px 0;padding:2px;border-radius:2px;">
                    <div style="font-size:10px;color:#999;">API Key:</div>
                    <div style="display:flex;gap:4px;">
                        <input id="zp-api-key" type="password" style="flex:1;background:#222;color:#0f0;border:1px solid #0f0;font-size:10px;padding:2px;border-radius:2px;">
                        <button id="zp-api-key-toggle" style="display:inline;width:24px;padding:0;font-size:10px;border:1px solid #999;color:#999;background:#333;border-radius:2px;">👁</button>
                    </div>
                    <div style="font-size:10px;color:#999;">Model:</div>
                    <input id="zp-api-model" style="width:100%;background:#222;color:#0f0;border:1px solid #0f0;font-size:10px;margin:2px 0;padding:2px;border-radius:2px;">
                    <button id="zp-btn-ai" style="border-color:#0ff;color:#0ff;margin-top:6px;">AI答题 (Ctrl+Q)</button>
                    <button id="zp-btn-ai-test" style="border-color:#ff0;color:#ff0;font-size:10px;">测试连接</button>
                    <div style="margin-top:4px;font-size:10px;">
                        进度: <span id="zp-ai-progress">-</span><br>
                        状态: <span id="zp-ai-status" style="color:#0f0;">待命中</span>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        document.getElementById('zp-btn-speed').onclick = () => {
            const newSpeed = cycleSpeed();
            document.getElementById('zp-speed').textContent = newSpeed + 'x';
        };
        document.getElementById('zp-btn-skip').onclick = skipCurrentFile;
        document.getElementById('zp-btn-next').onclick = goToNextLesson;
        document.getElementById('zp-btn-mute').onclick = () => {
            const v = getVideo();
            if (v) { v.muted = !v.muted; }
        };

        // AI 面板事件
        const aiToggle = document.getElementById('zp-ai-toggle');
        const aiConfig = document.getElementById('zp-ai-config');
        aiToggle.onclick = () => {
            const show = aiConfig.style.display === 'none';
            aiConfig.style.display = show ? 'block' : 'none';
            aiToggle.textContent = 'AI答题 [' + (show ? '收起' : '展开') + ']';
        };

        // 元素引用
        const apiUrlInput = document.getElementById('zp-api-url');
        const apiKeyInput = document.getElementById('zp-api-key');
        const modelInput = document.getElementById('zp-api-model');

        apiUrlInput.value = AI_CONFIG.apiUrl;
        apiKeyInput.value = AI_CONFIG.apiKey;
        modelInput.value = AI_CONFIG.model;

        // API Key 显示/隐藏切换
        document.getElementById('zp-api-key-toggle').onclick = () => {
            const isPass = apiKeyInput.type === 'password';
            apiKeyInput.type = isPass ? 'text' : 'password';
        };

        // 收集配置
        function collectConfig() {
            AI_CONFIG.apiUrl = apiUrlInput.value.trim();
            AI_CONFIG.apiKey = apiKeyInput.value.trim();
            AI_CONFIG.model = modelInput.value.trim() || AI_CONFIG.model;
            saveAIConfig();
        }

        document.getElementById('zp-btn-ai-test').onclick = () => {
            collectConfig();
            testAPIConnection();
        };

        document.getElementById('zp-btn-ai').onclick = () => {
            collectConfig();
            runAIAnswer();
        };

        setInterval(() => {
            const v = getVideo();
            const statusEl = document.getElementById('zp-status');
            const speedEl = document.getElementById('zp-speed');
            const tabEl = document.getElementById('zp-tab');

            // 更新 tab 信息
            const tabs = getContentTabs();
            const tabIdx = getCurrentTabIndex();
            if (tabs.length > 0 && tabIdx >= 0) {
                tabEl.textContent = (tabIdx + 1) + '/' + tabs.length + ' ' +
                    (getTabType(getActiveTabPane()) === 'video' ? '视频' : '文件');
            } else {
                tabEl.textContent = '-';
            }

            if (v && statusEl) {
                const remaining = v.duration - v.currentTime;
                const actualSpeed = v.playbackRate;
                const realRemaining = remaining / actualSpeed;
                statusEl.textContent = v.paused ? '已暂停' :
                    v.ended ? '视频结束' :
                    `剩余 ${Math.floor(realRemaining / 60)}分${Math.floor(realRemaining % 60)}秒`;
                if (speedEl) speedEl.textContent = actualSpeed + 'x';
            } else if (isFileLesson() && statusEl) {
                if (CONFIG.skipFileLessons) {
                    statusEl.textContent = '文件 | 自动跳过';
                } else if (fileViewCompleted) {
                    statusEl.textContent = '文件 | 计时完成';
                } else if (fileViewStartTime) {
                    const elapsed = Math.floor((Date.now() - fileViewStartTime) / 1000);
                    const remain = Math.max(0, CONFIG.fileViewMinTime - elapsed);
                    statusEl.textContent = '文件 | 还需' + remain + '秒';
                } else {
                    statusEl.textContent = '文件 | 等待中';
                }
                if (speedEl) speedEl.textContent = '-';
            }
        }, 1000);
    }

    // ==================== 启动 ====================
    function init() {
        log('ZJOOC 自动刷课脚本 v2.0 启动');

        closeDialogs();
        bindKeys();
        createPanel();

        setTimeout(attachVideoListeners, 800);
        setTimeout(() => {
            const v = getVideo();
            if (v) { setSpeed(v, CONFIG.speed); playVideo(v); }
            if (isFileLesson()) resetFileTimer();
        }, 1500);

        setInterval(tick, CONFIG.checkInterval);

        let lastUrl = location.href;
        setInterval(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                log('页面切换:', location.href.substring(location.href.lastIndexOf('/') + 1));
                onLessonChanged();
            }
        }, 1000);

        // 作业页面检测 (延迟等待DOM加载)
        if (isHomeworkPage()) {
            const checkQuestions = (retry) => {
                const count = extractAllQuestions().length;
                if (count > 0) {
                    log('检测到作业页面，共', count, '道题');
                    const aiConfig = document.getElementById('zp-ai-config');
                    const aiToggle = document.getElementById('zp-ai-toggle');
                    if (aiConfig && aiToggle) {
                        aiConfig.style.display = 'block';
                        aiToggle.textContent = 'AI答题 [收起]';
                    }
                } else if (retry < 10) {
                    setTimeout(() => checkQuestions(retry + 1), 800);
                } else {
                    log('作业页面题目加载超时，请刷新重试');
                }
            };
            setTimeout(() => checkQuestions(0), 1000);
        }

        log('初始化完成 | Ctrl+S=倍速 Ctrl+N=下一课 Ctrl+D=静音 Ctrl+F=跳过文件 Ctrl+Q=AI答题');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
