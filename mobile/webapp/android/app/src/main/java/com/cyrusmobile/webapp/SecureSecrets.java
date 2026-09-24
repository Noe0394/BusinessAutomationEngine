package com.cyrusmobile.webapp;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.net.URI;
import java.util.Locale;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class SecureSecrets {
    private static final String PREFS = "cyrus_encrypted_secrets";
    private static final String KEY_ALIAS = "cyrus_mobile_secret_key_v1";
    private static final String PREFIX = "business-service:";

    private SecureSecrets() {}

    static String reference(String serviceId) {
        if (serviceId == null || !serviceId.matches("[A-Za-z0-9_-]{1,100}")) {
            throw new IllegalArgumentException("Référence de service invalide.");
        }
        return PREFIX + serviceId;
    }

    static void put(Context context, String reference, String value, String baseUrl) throws Exception {
        if (value == null || value.isEmpty()) throw new IllegalArgumentException("Clé API vide.");
        String allowedOrigin = origin(baseUrl);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        ByteBuffer packed = ByteBuffer.allocate(4 + cipher.getIV().length + encrypted.length);
        packed.putInt(cipher.getIV().length);
        packed.put(cipher.getIV());
        packed.put(encrypted);
        boolean saved = preferences(context).edit()
                .putString(reference, Base64.encodeToString(packed.array(), Base64.NO_WRAP))
                .putString(reference + ":origin", allowedOrigin)
                .commit();
        if (!saved) throw new IllegalStateException("Écriture du coffre chiffré impossible.");
    }

    static String get(Context context, String reference, String requestedUrl) throws Exception {
        String encoded = preferences(context).getString(reference, null);
        if (encoded == null) return null;
        String allowedOrigin = preferences(context).getString(reference + ":origin", null);
        if (allowedOrigin == null || !allowedOrigin.equals(origin(requestedUrl))) {
            throw new SecurityException("La clé API ne peut être envoyée qu'à l'origine HTTPS configurée.");
        }
        byte[] packed = Base64.decode(encoded, Base64.NO_WRAP);
        ByteBuffer buffer = ByteBuffer.wrap(packed);
        int ivLength = buffer.getInt();
        if (ivLength < 12 || ivLength > 16 || buffer.remaining() <= ivLength) throw new IllegalStateException("Secret chiffré invalide.");
        byte[] iv = new byte[ivLength];
        buffer.get(iv);
        byte[] ciphertext = new byte[buffer.remaining()];
        buffer.get(ciphertext);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
    }

    static void remove(Context context, String reference) {
        boolean removed = preferences(context).edit().remove(reference).remove(reference + ":origin").commit();
        if (!removed) throw new IllegalStateException("Suppression du coffre chiffré impossible.");
    }

    private static String origin(String rawUrl) throws Exception {
        URI uri = new URI(rawUrl == null ? "" : rawUrl);
        String host = uri.getHost();
        if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null || host.isEmpty() || uri.getUserInfo() != null) {
            throw new IllegalArgumentException("Une origine HTTPS sans identifiants intégrés est requise.");
        }
        host = host.toLowerCase(Locale.ROOT);
        if (host.contains(":" ) && !host.startsWith("[")) host = "[" + host + "]";
        int port = uri.getPort();
        return "https://" + host + ((port < 0 || port == 443) ? "" : ":" + port);
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        java.security.Key existing = store.getKey(KEY_ALIAS, null);
        if (existing instanceof SecretKey) return (SecretKey) existing;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }
}
