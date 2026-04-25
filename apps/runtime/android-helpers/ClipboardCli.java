package dev.codesymphony.android;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

public final class ClipboardCli {
  private static final String ATTRIBUTION_TAG = "shell";
  private static final String CALLING_PACKAGE = "com.android.shell";
  private static final int DEVICE_ID_DEFAULT = 0;
  private static final int USER_ID_SYSTEM = 0;

  private ClipboardCli() {}

  public static void main(String[] args) throws Exception {
    if (args.length == 0) {
      throw new IllegalArgumentException("Expected command: get | set");
    }

    String command = args[0];
    Object clipboard = getClipboardService();
    if (clipboard == null) {
      throw new IllegalStateException("Clipboard service is unavailable.");
    }

    Class<?> clipDataClass = Class.forName("android.content.ClipData");
    if ("set".equals(command)) {
      String text = args.length >= 2 ? args[1] : "";
      setClipboardText(clipboard, clipDataClass, text);
      System.out.print("OK");
      return;
    }

    if ("set-base64".equals(command)) {
      String encoded = args.length >= 2 ? args[1] : "";
      String text = new String(decodeBase64(encoded), java.nio.charset.StandardCharsets.UTF_8);
      setClipboardText(clipboard, clipDataClass, text);
      System.out.print("OK");
      return;
    }

    if ("get".equals(command)) {
      Object clipData = invokeClipboardMethod(clipboard, "getPrimaryClip", null);
      if (clipData == null) {
        return;
      }

      Integer count = (Integer) clipDataClass.getMethod("getItemCount").invoke(clipData);
      if (count == null || count.intValue() <= 0) {
        return;
      }

      Object item = clipDataClass.getMethod("getItemAt", int.class).invoke(clipData, 0);
      Object text = item.getClass().getMethod("getText").invoke(item);
      if (text != null) {
        System.out.print(text.toString());
      }
      return;
    }

    throw new IllegalArgumentException("Unknown command: " + command);
  }

  private static void setClipboardText(Object clipboard, Class<?> clipDataClass, String text) throws Exception {
    Object clipData = clipDataClass
      .getMethod("newPlainText", CharSequence.class, CharSequence.class)
      .invoke(null, "codesymphony", text);
    invokeClipboardMethod(clipboard, "setPrimaryClip", clipData);
  }

  private static Object invokeClipboardMethod(Object clipboard, String methodName, Object firstArgument) throws Exception {
    Method bestMethod = null;
    Object[] bestArguments = null;

    for (Method method : clipboard.getClass().getMethods()) {
      if (!methodName.equals(method.getName())) {
        continue;
      }

      Object[] candidateArguments = buildClipboardInvocationArguments(method.getParameterTypes(), firstArgument);
      if (candidateArguments == null) {
        continue;
      }

      if (bestMethod == null || method.getParameterCount() > bestMethod.getParameterCount()) {
        bestMethod = method;
        bestArguments = candidateArguments;
      }
    }

    if (bestMethod == null || bestArguments == null) {
      throw new NoSuchMethodException("No compatible clipboard method found: " + methodName);
    }

    try {
      return bestMethod.invoke(clipboard, bestArguments);
    } catch (InvocationTargetException error) {
      Throwable cause = error.getCause();
      if (cause instanceof Exception) {
        throw (Exception) cause;
      }
      throw error;
    }
  }

  private static Object[] buildClipboardInvocationArguments(Class<?>[] parameterTypes, Object firstArgument) {
    Object[] arguments = new Object[parameterTypes.length];
    int offset = 0;

    if (firstArgument != null) {
      if (parameterTypes.length == 0 || !parameterTypes[0].isInstance(firstArgument)) {
        return null;
      }

      arguments[0] = firstArgument;
      offset = 1;
    }

    String[] stringArguments = {
      CALLING_PACKAGE,
      ATTRIBUTION_TAG,
    };
    Integer[] intArguments = {
      Integer.valueOf(USER_ID_SYSTEM),
      Integer.valueOf(DEVICE_ID_DEFAULT),
    };
    int stringIndex = 0;
    int intIndex = 0;

    for (int index = offset; index < parameterTypes.length; index++) {
      Class<?> parameterType = parameterTypes[index];
      if (String.class.equals(parameterType)) {
        if (stringIndex >= stringArguments.length) {
          return null;
        }

        arguments[index] = stringArguments[stringIndex];
        stringIndex += 1;
        continue;
      }

      if (Integer.TYPE.equals(parameterType) || Integer.class.equals(parameterType)) {
        if (intIndex >= intArguments.length) {
          return null;
        }

        arguments[index] = intArguments[intIndex];
        intIndex += 1;
        continue;
      }

      return null;
    }

    return arguments;
  }

  private static byte[] decodeBase64(String encoded) throws Exception {
    try {
      Class<?> base64Class = Class.forName("java.util.Base64");
      Object decoder = base64Class.getMethod("getDecoder").invoke(null);
      return (byte[]) decoder.getClass().getMethod("decode", String.class).invoke(decoder, encoded);
    } catch (ClassNotFoundException error) {
      Class<?> legacyBase64Class = Class.forName("android.util.Base64");
      return (byte[]) legacyBase64Class.getMethod("decode", String.class, int.class).invoke(null, encoded, Integer.valueOf(0));
    }
  }

  private static Object getClipboardService() throws Exception {
    Class<?> serviceManagerClass = Class.forName("android.os.ServiceManager");
    Object binder = serviceManagerClass.getMethod("getService", String.class).invoke(null, "clipboard");
    if (binder == null) {
      return null;
    }

    Class<?> binderClass = Class.forName("android.os.IBinder");
    Class<?> stubClass = Class.forName("android.content.IClipboard$Stub");
    return stubClass.getMethod("asInterface", binderClass).invoke(null, binder);
  }
}
