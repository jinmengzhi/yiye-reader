package com.local.onepagereader;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "FolderPicker")
public class FolderPickerPlugin extends Plugin {
    @PluginMethod
    public void pickFiles(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {
            "text/plain", "application/zip", "application/x-zip-compressed", "application/octet-stream"
        });
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "filesResult");
    }

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, intent, "folderResult");
    }

    @PluginMethod
    public void listFolder(PluginCall call) {
        String uri = call.getString("uri");
        if (uri == null || uri.isEmpty()) {
            call.reject("文件夹路径无效");
            return;
        }
        try {
            call.resolve(buildFilesResult(Uri.parse(uri)));
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "文件夹读取失败" : error.getMessage());
        }
    }

    @PluginMethod
    public void getFileInfo(PluginCall call) {
        String uriValue = call.getString("uri");
        if (uriValue == null || uriValue.isEmpty()) {
            call.reject("文件路径无效");
            return;
        }
        try {
            Uri uri = Uri.parse(uriValue);
            DocumentFile file = DocumentFile.fromSingleUri(getContext(), uri);
            String name = file == null ? uri.getLastPathSegment() : file.getName();
            if (name == null || name.isEmpty() || !isSupportedImportFile(name)) {
                call.reject("请选择 TXT 文件或 ZIP 压缩包");
                return;
            }
            JSObject item = new JSObject();
            item.put("name", name);
            item.put("uri", uri.toString());
            item.put("size", file == null ? 0 : file.length());
            item.put("modifiedAt", file == null ? 0 : file.lastModified());
            call.resolve(item);
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "无法读取这个文件" : error.getMessage());
        }
    }

    @PluginMethod
    public void deleteFile(PluginCall call) {
        String uri = call.getString("uri");
        if (uri == null || uri.isEmpty()) {
            call.reject("源文件路径无效");
            return;
        }
        try {
            if (!DocumentsContract.deleteDocument(getContext().getContentResolver(), Uri.parse(uri))) {
                call.reject("无法删除源 TXT 文件");
                return;
            }
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "无法删除源 TXT 文件" : error.getMessage());
        }
    }

    @PluginMethod
    public void renameFile(PluginCall call) {
        String uri = call.getString("uri");
        String name = call.getString("name");
        if (uri == null || uri.isEmpty() || name == null || name.isEmpty()) {
            call.reject("源文件或新文件名无效");
            return;
        }
        try {
            Uri renamedUri = DocumentsContract.renameDocument(getContext().getContentResolver(), Uri.parse(uri), name);
            if (renamedUri == null) {
                call.reject("无法重命名源 TXT 文件");
                return;
            }
            JSObject result = new JSObject();
            result.put("uri", renamedUri.toString());
            result.put("name", name);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "无法重命名源 TXT 文件" : error.getMessage());
        }
    }

    @ActivityCallback
    private void folderResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("Folder picker canceled");
            return;
        }
        Intent data = result.getData();
        Uri uri = data.getData();
        persistUriPermission(uri, data.getFlags());
        try {
            call.resolve(buildFolderResult(uri));
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "文件夹读取失败" : error.getMessage());
        }
    }

    @ActivityCallback
    private void filesResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("File picker canceled");
            return;
        }
        Intent data = result.getData();
        JSArray files = new JSArray();
        if (data.getClipData() != null) {
            for (int index = 0; index < data.getClipData().getItemCount(); index++) {
            addSelectedFile(files, data.getClipData().getItemAt(index).getUri(), data.getFlags());
            }
        } else if (data.getData() != null) {
            addSelectedFile(files, data.getData(), data.getFlags());
        }
        JSObject response = new JSObject();
        response.put("files", files);
        call.resolve(response);
    }

    private JSObject buildFilesResult(Uri uri) {
        DocumentFile folder = DocumentFile.fromTreeUri(getContext(), uri);
        if (folder == null || !folder.isDirectory()) throw new IllegalStateException("无法打开文件夹");
        JSArray files = new JSArray();
        addFilesRecursively(files, folder, "", 0);
        JSObject response = new JSObject();
        response.put("files", files);
        return response;
    }

    private void addFilesRecursively(JSArray files, DocumentFile folder, String parentPath, int depth) {
        if (depth > 64) return;
        for (DocumentFile child : folder.listFiles()) {
            if (child == null || child.getName() == null) continue;
            String relativePath = parentPath.isEmpty() ? child.getName() : parentPath + "/" + child.getName();
            if (child.isDirectory()) addFilesRecursively(files, child, relativePath, depth + 1);
            else addFile(files, child, relativePath);
        }
    }

    private void addFile(JSArray files, DocumentFile file, String relativePath) {
        if (file == null || !file.isFile() || file.getName() == null || !file.getName().toLowerCase().endsWith(".txt")) return;
        JSObject item = new JSObject();
        item.put("name", file.getName());
        item.put("uri", file.getUri().toString());
        item.put("size", file.length());
        item.put("modifiedAt", file.lastModified());
        item.put("relativePath", relativePath);
        files.put(item);
    }

    private void addSelectedFile(JSArray files, Uri uri, int resultFlags) {
        if (uri == null) return;
        persistUriPermission(uri, resultFlags);
        DocumentFile file = DocumentFile.fromSingleUri(getContext(), uri);
        if (file == null || !file.isFile() || file.getName() == null || !isSupportedImportFile(file.getName())) return;
        JSObject item = new JSObject();
        item.put("name", file.getName());
        item.put("uri", uri.toString());
        item.put("size", file.length());
        files.put(item);
    }

    private boolean isSupportedImportFile(String name) {
        String normalized = name.toLowerCase();
        return normalized.endsWith(".txt") || normalized.endsWith(".zip");
    }

    private void persistUriPermission(Uri uri, int resultFlags) {
        int persistableFlags = resultFlags & (
            Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        );
        if (persistableFlags == 0) return;
        try {
            getContext().getContentResolver().takePersistableUriPermission(uri, persistableFlags);
        } catch (SecurityException ignored) {
            // Some providers do not expose persistent permissions; the current grant is still usable.
        }
    }

    private JSObject buildFolderResult(Uri uri) {
        DocumentFile folder = DocumentFile.fromTreeUri(getContext(), uri);
        if (folder == null || !folder.isDirectory()) throw new IllegalStateException("无法打开文件夹");
        JSObject result = new JSObject();
        result.put("name", folder.getName() == null ? "常用文件夹" : folder.getName());
        result.put("uri", uri.toString());
        result.put("displayPath", getDisplayPath(uri));
        return result;
    }

    private String getDisplayPath(Uri uri) {
        String documentId = DocumentsContract.getTreeDocumentId(uri);
        if (documentId == null || documentId.isEmpty()) return "已授权文件夹";
        String normalized = documentId.replace(':', '/');
        if (normalized.startsWith("primary/")) return "手机存储 / " + normalized.substring("primary/".length());
        return normalized;
    }
}
