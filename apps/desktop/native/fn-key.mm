#import <AppKit/AppKit.h>
#include <node_api.h>

// App-local events only. No global tap, Accessibility permission, or background hotkey.
static napi_env jsEnv;
static napi_threadsafe_function listener;
static id monitor;
static bool enabled = false;
static bool down = false;
static bool blocked = false;

static void deliver(napi_env env, napi_value callback, void *, void *data) {
  if (!env || !callback) return;
  napi_value global, arg, result;
  napi_get_global(env, &global);
  napi_create_string_utf8(env, static_cast<const char *>(data), NAPI_AUTO_LENGTH, &arg);
  napi_call_function(env, global, callback, 1, &arg, &result);
}
static void emit(const char *kind) {
  if (listener) napi_call_threadsafe_function(listener, const_cast<char *>(kind), napi_tsfn_nonblocking);
}
static void stopWatching() {
  if (monitor) [NSEvent removeMonitor:monitor];
  monitor = nil;
  down = blocked = enabled = false;
  if (listener) napi_release_threadsafe_function(listener, napi_tsfn_abort);
  listener = nullptr;
}
static napi_value start(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1];
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  napi_valuetype type;
  if (count != 1 || napi_typeof(env, args[0], &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(env, nullptr, "Expected an Fn event listener"); return nullptr;
  }
  stopWatching(); jsEnv = env;
  napi_value name;
  napi_create_string_utf8(env, "Parallax Fn key", NAPI_AUTO_LENGTH, &name);
  napi_create_threadsafe_function(env, args[0], nullptr, name, 0, 1, nullptr, nullptr, nullptr, deliver, &listener);
  napi_unref_threadsafe_function(env, listener);
  monitor = [NSEvent addLocalMonitorForEventsMatchingMask:(NSEventMaskFlagsChanged | NSEventMaskKeyDown) handler:^NSEvent *(NSEvent *event) {
    if (!enabled || !NSApp.isActive) return event;
    if (event.type == NSEventTypeKeyDown) {
      if (down) { down = false; blocked = true; emit("cancel"); }
      return event;
    }
    if (event.keyCode != 63) {
      if (down) { down = false; blocked = true; emit("cancel"); }
      return event;
    }
    bool pressed = (event.modifierFlags & NSEventModifierFlagFunction) != 0;
    NSEventModifierFlags other = event.modifierFlags & (NSEventModifierFlagShift | NSEventModifierFlagControl | NSEventModifierFlagOption | NSEventModifierFlagCommand);
    if (!pressed) {
      bool wasDown = down; down = blocked = false;
      if (wasDown) emit("up");
    } else if (!blocked && !down && !other) { down = true; emit("down"); }
    return nil;
  }];
  if (!monitor) { stopWatching(); napi_throw_error(env, nullptr, "Could not observe Fn in this app"); }
  return nullptr;
}
static napi_value setEnabled(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; bool next = false;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count == 1) napi_get_value_bool(env, args[0], &next);
  if (!next && down) { down = false; emit("cancel"); }
  if (!next) blocked = false;
  enabled = next;
  return nullptr;
}
static napi_value stop(napi_env env, napi_callback_info info) { stopWatching(); return nullptr; }
static void cleanup(void *) { stopWatching(); }
static napi_value init(napi_env env, napi_value exports) {
  jsEnv = env;
  napi_property_descriptor properties[] = {
    {"start", nullptr, start, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stop", nullptr, stop, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"setEnabled", nullptr, setEnabled, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_define_properties(env, exports, 3, properties);
  napi_add_env_cleanup_hook(env, cleanup, nullptr);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
