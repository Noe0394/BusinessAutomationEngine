package com.cyrusmobile.webapp;

import android.annotation.SuppressLint;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.HashMap;
import java.util.Map;

// Reproduit ce que react-native-webview offrait cote React Native
// (injectedJavaScript + onMessage) : une WebView Android native pilotable
// depuis JS (charger une URL, injecter/evaluer du JS, recevoir des
// postMessage). Necessaire ici car un <iframe> cross-origin classique ne
// permet PAS a une page web d'injecter du JS dans web.whatsapp.com/
// web.telegram.org (politique de meme origine du navigateur) - seule une
// API native (evaluateJavascript) le permet. Plusieurs instances nommees
// (id) coexistent : une pour WhatsApp, une pour Telegram.
@CapacitorPlugin(name = "EmbeddedWebView")
public class EmbeddedWebViewPlugin extends Plugin {
    private final Map<String, WebView> webViews = new HashMap<>();

    @SuppressLint("SetJavaScriptEnabled")
    @PluginMethod
    public void open(PluginCall call) {
        String id = call.getString("id");
        String url = call.getString("url");
        String userAgent = call.getString("userAgent");
        if (id == null || url == null) {
            call.reject("id et url requis");
            return;
        }

        getActivity().runOnUiThread(() -> {
            WebView existing = webViews.get(id);
            if (existing != null) {
                ((ViewGroup) existing.getParent()).removeView(existing);
                existing.destroy();
            }

            WebView webView = new WebView(getActivity());
            WebSettings settings = webView.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);
            if (userAgent != null && !userAgent.isEmpty()) {
                settings.setUserAgentString(userAgent);
            }
            webView.addJavascriptInterface(new JsBridge(id), "Cyrus");

            // Un ViewGroup.LayoutParams generique plutot que "new
            // FrameLayout.LayoutParams(...)" en dur : le parent reel de la
            // WebView Capacitor est un CoordinatorLayout (pas un FrameLayout)
            // sur ce projet - un cast en dur vers FrameLayout.LayoutParams plus
            // loin (setBounds) faisait planter l'app au lancement avec
            // ClassCastException, constate sur appareil le 2026-09-10.
            // ViewGroup.addView(view, index, params) convertit automatiquement
            // ces LayoutParams generiques vers le type concret du parent en
            // interne (ViewGroup.generateLayoutParams(), protected - inutile
            // et inaccessible de l'appeler soi-meme ici).
            ViewGroup parent = (ViewGroup) getBridge().getWebView().getParent();
            ViewGroup.LayoutParams params = new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            );
            // Ajoutee sous la WebView principale de Capacitor (qui reste au-dessus
            // et affiche l'UI de l'app) - visible seulement quand setVisible(true)
            // est appele, voir la logique de visibilite plus bas.
            parent.addView(webView, 0, params);
            webView.setVisibility(android.view.View.GONE);

            webViews.put(id, webView);
            webView.loadUrl(url);
            call.resolve();
        });
    }

    @PluginMethod
    public void setVisible(PluginCall call) {
        String id = call.getString("id");
        boolean visible = Boolean.TRUE.equals(call.getBoolean("visible"));
        WebView webView = webViews.get(id);
        if (webView == null) {
            call.reject("WebView inconnue: " + id);
            return;
        }
        getActivity().runOnUiThread(() -> {
            webView.setVisibility(visible ? android.view.View.VISIBLE : android.view.View.GONE);
            if (visible) {
                webView.bringToFront();
            }
            call.resolve();
        });
    }

    // Une View native ajoutee au-dessus de la WebView Capacitor s'affiche
    // TOUJOURS par-dessus tout son contenu web, quel que soit le CSS
    // (z-index n'a aucun effet sur une couche native) - une WebView
    // embarquee en MATCH_PARENT masquait donc entierement l'entete/la nav
    // HTML de l'app (constate sur appareil, 2026-09-10). setBounds()
    // positionne la WebView embarquee dans une zone precise (en pixels
    // ecran, calcules cote JS via getBoundingClientRect() *
    // devicePixelRatio) pour laisser l'entete/la nav de l'app cliquables.
    @PluginMethod
    public void setBounds(PluginCall call) {
        String id = call.getString("id");
        WebView webView = webViews.get(id);
        if (webView == null) {
            call.reject("WebView inconnue: " + id);
            return;
        }
        int top = call.getInt("top", 0);
        int bottom = call.getInt("bottom", 0);
        getActivity().runOnUiThread(() -> {
            // ViewGroup.MarginLayoutParams (pas FrameLayout.LayoutParams) : le
            // supertype commun qui porte setMargins(), valable quel que soit le
            // type concret reel des LayoutParams du parent (CoordinatorLayout
            // ici, voir open() ci-dessus) - voir le commentaire de open() pour
            // le crash que le cast en dur precedent provoquait.
            ViewGroup.MarginLayoutParams params = (ViewGroup.MarginLayoutParams) webView.getLayoutParams();
            params.setMargins(0, top, 0, bottom);
            webView.setLayoutParams(params);
            call.resolve();
        });
    }

    @PluginMethod
    public void evaluate(PluginCall call) {
        String id = call.getString("id");
        String script = call.getString("script");
        WebView webView = webViews.get(id);
        if (webView == null) {
            call.reject("WebView inconnue: " + id);
            return;
        }
        getActivity().runOnUiThread(() -> webView.evaluateJavascript(script, null));
        call.resolve();
    }

    @PluginMethod
    public void close(PluginCall call) {
        String id = call.getString("id");
        WebView webView = webViews.remove(id);
        if (webView != null) {
            getActivity().runOnUiThread(() -> {
                ((ViewGroup) webView.getParent()).removeView(webView);
                webView.destroy();
            });
        }
        call.resolve();
    }

    // Deconnexion reelle (page Connexions, feuille de route) - contrairement
    // a close(), qui detruit juste la vue sans toucher au stockage : le
    // CookieManager et le WebStorage sont PARTAGES par toutes les WebView de
    // l'app (pas isoles par instance), donc reouvrir web.whatsapp.com/
    // web.telegram.org apres un simple close() rechargerait la session
    // encore valide au lieu de redemander un appairage. removeAllCookies/
    // deleteAllData effacent cette session pour TOUTES les WebView du
    // process, ce qui est le comportement voulu ici (une seule WebView par
    // canal existe a la fois).
    @PluginMethod
    public void logout(PluginCall call) {
        String id = call.getString("id");
        WebView webView = webViews.remove(id);
        getActivity().runOnUiThread(() -> {
            if (webView != null) {
                webView.clearCache(true);
                webView.clearHistory();
                ((ViewGroup) webView.getParent()).removeView(webView);
                webView.destroy();
            }
            CookieManager cookieManager = CookieManager.getInstance();
            cookieManager.removeAllCookies(null);
            cookieManager.flush();
            WebStorage.getInstance().deleteAllData();
            call.resolve();
        });
    }

    // Pont expose dans la WebView embarquee sous window.Cyrus.postMessage(json) -
    // equivalent de window.ReactNativeWebView.postMessage cote React Native.
    // Les scripts injectes (voir www/whatsappBridge.js, www/telegramBridge.js)
    // l'appellent directement.
    private class JsBridge {
        private final String webViewId;

        JsBridge(String webViewId) {
            this.webViewId = webViewId;
        }

        @JavascriptInterface
        public void postMessage(String json) {
            JSObject event = new JSObject();
            event.put("id", webViewId);
            event.put("data", json);
            notifyListeners("message", event);
        }
    }
}
