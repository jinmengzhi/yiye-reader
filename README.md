# 一页 TXT 阅读器

“一页”是一个纯本地、离线运行的 Android TXT 阅读器。它支持本机 TXT 导入、常见中文编码、滚动阅读、进度保存、阅读设置和完整备份迁移。

## 浏览器预览

环境要求：Node.js 20.19+。

```powershell
npm install
npm run dev
```

开发服务器默认显示本机和局域网访问地址。同一 Wi-Fi 下，可在手机浏览器打开局域网地址进行预览。

生产构建：

```powershell
npm run build
```

## Android 工程

Android 工程位于 `android/`，使用 Capacitor 8 生成。构建环境需要：

- Android Studio（包含兼容的 JDK，建议使用 Android Studio 内置 JDK 21）
- Android SDK Platform 36
- Android SDK Build-Tools

前端修改后同步 Android：

```powershell
npm run build
npx cap sync android
```

用 Android Studio 打开工程：

```powershell
npx cap open android
```

或者在 SDK 和 JDK 已配置好的终端中构建 Debug APK：

```powershell
cd android
.\gradlew.bat assembleDebug
```

成功后 APK 位于：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

## 数据说明

- TXT 内容、阅读进度和设置保存在应用本地。
- Android 应用不声明联网权限，并禁止 Android 系统自动云备份应用数据。
- 完整备份使用 `.reader-backup` 扩展名，其中包含原始 TXT 内容，不加密。
- 换手机时，在旧手机导出完整备份，再在新手机选择该文件恢复。
