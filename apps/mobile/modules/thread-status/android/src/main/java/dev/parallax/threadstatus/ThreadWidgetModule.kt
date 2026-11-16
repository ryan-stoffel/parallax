// The Android side of index.ts's ThreadWidget: keeps the rows the home screen widget draws, which the
// app and its push task decide on in JS (src/androidThreads.ts), and redraws the widget. They stay in
// the app's own storage, where nothing else can read them.
package dev.parallax.threadstatus

import android.content.Context
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ThreadWidgetModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("ThreadWidget")

    /** The threads kept, as JSON of `StatusEntry[]` (src/threadStatus.ts). */
    Function("read") { ThreadWidgetProvider.read(context, THREADS) ?: "[]" }

    /** Keeps `threads` and `labels`, each state's word in the app's language, and redraws. */
    Function("show") { threads: String, labels: String ->
      ThreadWidgetProvider.save(context, threads, labels)
    }

    /** Removes every thread, for signing out. */
    Function("clear") { ThreadWidgetProvider.save(context, "[]", null) }
  }
}
