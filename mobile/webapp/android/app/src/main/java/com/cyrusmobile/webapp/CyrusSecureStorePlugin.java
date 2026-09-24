package com.cyrusmobile.webapp;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "CyrusSecureStore")
public class CyrusSecureStorePlugin extends Plugin {
    @PluginMethod
    public void set(PluginCall call) {
        String serviceId = call.getString("serviceId");
        String value = call.getString("value");
        String baseUrl = call.getString("baseUrl");
        if (serviceId == null || value == null || baseUrl == null) {
            call.reject("serviceId, value et baseUrl sont requis.");
            return;
        }
        try {
            SecureSecrets.put(getContext(), SecureSecrets.reference(serviceId), value, baseUrl);
            JSObject result = new JSObject();
            result.put("ok", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Impossible de chiffrer la clé API sur cet appareil.", error);
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String serviceId = call.getString("serviceId");
        if (serviceId == null) {
            call.reject("serviceId requis.");
            return;
        }
        try {
            SecureSecrets.remove(getContext(), SecureSecrets.reference(serviceId));
            JSObject result = new JSObject();
            result.put("ok", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Impossible de supprimer la clé API locale.", error);
        }
    }
}
