# Source this before any Android build command:  source packages/mobile/android-env.sh
# Sets the home-dir JDK 17 + Android SDK installed for the EvilLite mobile build
# (no system packages / sudo needed).
export JAVA_HOME="$(ls -d "$HOME"/opt/jdk-17* 2>/dev/null | head -1)"
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/emulator:$PATH"
