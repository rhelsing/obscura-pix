package com.obscuraapp

import android.content.SharedPreferences
import com.obscura.kit.persistence.SessionStorage

/**
 * Android-backed [SessionStorage] for the kit, on a dedicated SharedPreferences
 * file. The kit owns *what* to persist and *when* (connect + token rotation);
 * this just reads/writes the blob, so there is no second, app-owned session
 * state machine.
 *
 * Honors the [SessionStorage] replace-whole-blob contract: [save] clears the
 * file first, then writes exactly `data` — so a key absent from `data` is gone.
 * Callers (persistSession / defineModelsFromJson) load-merge-save, so nothing is
 * dropped. Values are String or Int (registrationId).
 */
class SharedPreferencesSessionStorage(
    private val prefs: SharedPreferences
) : SessionStorage {

    override fun save(data: Map<String, Any?>) {
        // commit() (synchronous) rather than apply(): the persisted refresh token
        // is single-use and rotated on every refresh. If the process dies before an
        // async apply() reaches disk, a consumed refresh token would be restored on
        // next launch and 401 — the exact failure this storage exists to prevent.
        val editor = prefs.edit().clear()
        for ((key, value) in data) {
            when (value) {
                null -> { /* omit — replace semantics: absent key = not stored */ }
                is Int -> editor.putInt(key, value)
                is Number -> editor.putInt(key, value.toInt())
                is Boolean -> editor.putBoolean(key, value)
                else -> editor.putString(key, value.toString())
            }
        }
        editor.commit()
    }

    override fun load(): Map<String, Any?>? {
        val all = prefs.all
        if (all.isEmpty()) return null
        return all
    }

    override fun clear() {
        prefs.edit().clear().commit()
    }
}
