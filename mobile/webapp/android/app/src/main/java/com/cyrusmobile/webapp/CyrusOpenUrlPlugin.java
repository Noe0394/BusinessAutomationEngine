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
            String redirectValue = uri.getQueryParameter("redirect_uri");
            Uri redirect = Uri.parse(redirectValue == null ? "" : redirectValue);
            boolean communityLink = "https".equalsIgnoreCase(uri.getScheme())
                    && uri.getPort() == -1 && uri.getUserInfo() == null
                    && (host.equals("chat.whatsapp.com") || host.equals("t.me"));
            boolean facebookOAuth = "https".equalsIgnoreCase(uri.getScheme())
                    && uri.getPort() == -1 && uri.getUserInfo() == null
                    && host.equals("www.facebook.com")
                    && uri.getPath() != null && uri.getPath().matches("/v[0-9]+\\.[0-9]+/dialog/oauth")
                    && uri.getQueryParameter("client_id") != null
                    && uri.getQueryParameter("client_id").matches("[0-9]{1,30}")
                    && redirectValue != null && "https".equalsIgnoreCase(redirect.getScheme())
                    && redirect.getPort() == -1 && redirect.getUserInfo() == null
                    && "/facebook/oauth/callback".equals(redirect.getPath())
                    && uri.getQueryParameter("state") != null
                    && uri.getQueryParameter("state").matches("[a-fA-F0-9]{64}");
            if (!communityLink && !facebookOAuth) {
                call.reject("URL hors liste: liens communautaires officiels ou OAuth Facebook CYRUS seulement.");
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
