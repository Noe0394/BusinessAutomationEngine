package com.cyrusmobile.webapp;

import android.content.Intent;
import android.os.Bundle;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(EmbeddedWebViewPlugin.class);
        super.onCreate(savedInstanceState);

        // Demarre le service de premier plan des le lancement, sans
        // condition (meme principe que MainApplication.kt dans l'ancien
        // projet CyrusMobile) - couvre les deux WebView embarquees
        // (WhatsApp/Telegram), qui doivent continuer d'executer leur JS pour
        // recevoir des messages meme app en arriere-plan/ecran verrouille.
        ContextCompat.startForegroundService(this, new Intent(this, KeepAliveService.class));
    }
}
