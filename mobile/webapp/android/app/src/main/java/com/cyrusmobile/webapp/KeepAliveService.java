package com.cyrusmobile.webapp;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;

// Service de premier plan minimal - port direct du meme mecanisme deja
// valide dans mobile/CyrusMobile/android/.../KeepAliveService.kt (React
// Native/nodejs-mobile, abandonne pour ce projet). Son seul but est de
// garder le PROCESSUS de l'app vivant quand elle passe en arriere-plan ou
// que l'ecran se verrouille - c'est le seul mecanisme fiable sur Android
// pour ca (un wake-lock bricole consommerait plus de batterie pour un
// resultat moins sur). Sans ce service, Android peut suspendre l'execution
// JS des WebView WhatsApp/Telegram embarquees (voir EmbeddedWebViewPlugin) et
// donc interrompre une campagne en cours ou la reception de messages des que
// l'app quitte le premier plan.
public class KeepAliveService extends Service {
    private static final String CHANNEL_ID = "cyrus_webapp_keepalive";
    private static final int NOTIFICATION_ID = 1;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, buildNotification());
        return START_STICKY;
    }

    private Notification buildNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "WhatsApp/Telegram (CYRUS)",
                NotificationManager.IMPORTANCE_MIN
            );
            manager.createNotificationChannel(channel);
        }

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("CYRUS actif en arrière-plan")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .build();
    }
}
