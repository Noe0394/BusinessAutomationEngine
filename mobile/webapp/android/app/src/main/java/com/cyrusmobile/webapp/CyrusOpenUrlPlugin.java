package com.cyrusmobile.webapp;

import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Locale;

@CapacitorPlugin(name = "CyrusOpenUrl")
public class CyrusOpenUrlPlugin extends Plugin {
    @PluginMethod
    public void open(PluginCall call) {
        String rawUrl = call.getString("url");
        try {
            Uri uri = Uri.parse(rawUrl == null ? "" : rawUrl);
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
            boolean allowed = "https".equalsIgnoreCase(uri.getScheme())
                    && uri.getPort() == -1 && uri.getUserInfo() == null
                    && (host.equals("chat.whatsapp.com") || host.equals("t.me"));
            if (!allowed) {
                call.reject("Seuls les liens HTTPS officiels chat.whatsapp.com et t.me sont autorisés.");
                return;
            }
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            getContext().startActivity(intent);
            JSObject result = new JSObject();
            result.put("ok", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Impossible d'ouvrir le lien communautaire.", error);
        }
    }
}
