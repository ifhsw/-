# ZJOOC 自动刷课助手 - 使用说明

浙江省高等学校在线开放课程共享平台 (zjooc.cn) 自动刷课油猴脚本。

## 安装

1. 浏览器安装 **Tampermonkey**（油猴）扩展
   - Edge: [Microsoft Edge 加载项](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)
   - Chrome: [Chrome 网上应用店](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)

2. 打开 Tampermonkey → **添加新脚本**（+ 号）

3. 将 `zjooc-auto-course.user.js` 文件内容全部复制粘贴进去

4. `Ctrl+S` 保存，看到脚本列表中出现即安装成功

## 使用

直接打开课程页面，脚本自动运行。右上角出现绿色控制面板表示工作中。

### 自动功能

- 进入课程**自动播放**视频
- 视频播完**自动跳转**下一节课
- 自动关闭"完善个人信息"等弹窗
- 跨章节自动展开并进入下一章

### 控制面板

| 按钮 | 说明 |
|------|------|
| 切换速度 | 循环切换播放倍速 |
| 下一课 | 手动跳到下一节 |
| 切换静音 | 开关静音 |

面板显示当前速度和剩余时间。

### 键盘快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+S` | 切换倍速 |
| `Ctrl+N` | 下一课 |
| `Ctrl+D` | 切换静音 |
| `Ctrl+→` | 快进 10 秒 |
| `Ctrl+←` | 后退 10 秒 |

### 播放倍速

支持 8 档：**1x → 1.25x → 1.5x → 2x → 3x → 4x → 8x → 16x**

默认 1x 启动，按 `Ctrl+S` 或点按钮逐档切换。

## 适用页面

```
https://www.zjooc.cn/ucenter/student/course/study/*
```

只有课程学习页会自动运行，其他页面不触发。

## 注意事项

- 脚本运行时无需人工操作，可以后台标签页运行
- 建议不要最小化浏览器窗口，保持在后台标签即可
- 如遇页面异常，刷新页面即可重新开始
