# ---------------------------------------------------------------------------
# Obscura Android R8 / ProGuard rules.
#
# React Native, AndroidX, OkHttp, Hermes, etc. ship their own consumer rules
# through the AAR pipeline — we only declare what's *not* already covered.
# ---------------------------------------------------------------------------

# ----- libsignal -----------------------------------------------------------
# Everything under org.signal.libsignal is touched by JNI from native code.
# The native side resolves Java classes/methods by name via reflection.
-keep class org.signal.libsignal.** { *; }
-keepclassmembers class org.signal.libsignal.** {
    native <methods>;
}
-dontwarn org.signal.libsignal.**

# ----- Google protobuf-java (full runtime) ---------------------------------
# Proto descriptors are loaded reflectively; keep generated message classes.
-keep class com.google.protobuf.** { *; }
-keepclassmembers class * extends com.google.protobuf.GeneratedMessageV3 { *; }
-keepclassmembers class * extends com.google.protobuf.GeneratedMessageLite { *; }
-dontwarn com.google.protobuf.**

# ----- ObscuraKit ----------------------------------------------------------
# The kit exposes a small Kotlin/SQLDelight API; keep its public surface so
# the bridge (which goes through reflection in some places) and our own
# Kotlin call sites continue to resolve after R8 renames.
-keep class com.obscura.kit.** { *; }
-keepclassmembers class com.obscura.kit.** { *; }
-dontwarn com.obscura.kit.**

# ----- SQLDelight + sqlite ------------------------------------------------
-dontwarn app.cash.sqldelight.**

# ----- Our own bridge -----------------------------------------------------
# RN looks up ReactPackage / ReactModule classes by name. Keep them, their
# @ReactMethod handlers, and the Session singleton (called from native FCM
# service via reflection of Kotlin object companions).
-keep class com.obscuraapp.ObscuraSession { *; }
-keep class com.obscuraapp.ObscuraSession$* { *; }
-keep class com.obscuraapp.ObscuraBridgeModule { *; }
-keep class com.obscuraapp.ObscuraBridgePackage { *; }
-keep class com.obscuraapp.ObscuraMessagingService { *; }
-keep class com.obscuraapp.MainApplication { *; }
-keep class com.obscuraapp.MainActivity { *; }

# Kotlin metadata is needed for the kit's coroutine continuations to be
# preserved across the suspend-bridge boundary.
-keep class kotlin.Metadata { *; }
-keepattributes RuntimeVisibleAnnotations,AnnotationDefault

# ----- Quality-of-life ----------------------------------------------------
-dontwarn javax.annotation.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**
-dontwarn org.slf4j.**
-dontwarn java.sql.**
