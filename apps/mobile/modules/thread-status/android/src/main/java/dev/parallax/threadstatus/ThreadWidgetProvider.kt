// The home screen widget (0100): up to three of the threads ThreadWidgetModule keeps, what needs the
// user first, each opening its thread. It changes only when the app or its push task saves new rows,
// so it has no update period. It's for the home screen only (xml/thread_widget_info.xml), since a
// lock screen that takes widgets would show thread names.
package dev.parallax.threadstatus

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.widget.RemoteViews
import org.json.JSONArray
import org.json.JSONObject

const val THREADS = "threads"
private const val LABELS = "labels"
private const val STORE = "threadWidget"
private const val THREADS_LINK = "parallax://threads"

private val rows = listOf(
  Triple(R.id.row0, R.id.title0, Pair(R.id.mark0, R.id.state0)),
  Triple(R.id.row1, R.id.title1, Pair(R.id.mark1, R.id.state1)),
  Triple(R.id.row2, R.id.title2, Pair(R.id.mark2, R.id.state2)),
)

class ThreadWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    manager.updateAppWidget(ids, draw(context))
  }

  companion object {
    fun read(context: Context, key: String): String? =
      context.getSharedPreferences(STORE, Context.MODE_PRIVATE).getString(key, null)

    /** Keeps `threads`, and `labels` unless null, then redraws every placed widget. */
    fun save(context: Context, threads: String, labels: String?) {
      context.getSharedPreferences(STORE, Context.MODE_PRIVATE).edit().apply {
        putString(THREADS, threads)
        if (labels != null) putString(LABELS, labels)
      }.commit()
      val manager = AppWidgetManager.getInstance(context)
      val ids = manager.getAppWidgetIds(ComponentName(context, ThreadWidgetProvider::class.java))
      if (ids.isNotEmpty()) manager.updateAppWidget(ids, draw(context))
    }

    private fun open(context: Context, code: Int, link: String): PendingIntent =
      PendingIntent.getActivity(
        context,
        code,
        Intent(Intent.ACTION_VIEW, Uri.parse(link)).setPackage(context.packageName),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )

    private fun color(state: String) = when (state) {
      "needsYou" -> R.color.thread_widget_needs_you
      "working" -> R.color.thread_widget_working
      "failed" -> R.color.thread_widget_failed
      else -> R.color.thread_widget_muted
    }

    private fun draw(context: Context): RemoteViews {
      val views = RemoteViews(context.packageName, R.layout.thread_widget)
      val threads = runCatching { JSONArray(read(context, THREADS) ?: "[]") }.getOrDefault(JSONArray())
      val labels = runCatching { JSONObject(read(context, LABELS) ?: "{}") }.getOrDefault(JSONObject())
      views.setOnClickPendingIntent(R.id.thread_widget, open(context, 0, THREADS_LINK))
      labels.optString("empty").takeIf { it.isNotEmpty() }?.let { views.setTextViewText(R.id.empty, it) }
      views.setViewVisibility(R.id.empty, if (threads.length() == 0) View.VISIBLE else View.GONE)
      rows.forEachIndexed { i, (row, title, markAndState) ->
        val thread = threads.optJSONObject(i)
        views.setViewVisibility(row, if (thread == null) View.GONE else View.VISIBLE)
        if (thread == null) return@forEachIndexed
        val state = thread.optString("state")
        views.setTextViewText(title, thread.optString("title"))
        views.setTextViewText(markAndState.second, labels.optString(state, state))
        views.setTextColor(markAndState.first, context.getColor(color(state)))
        val link = thread.optString("link").takeIf { it.isNotEmpty() } ?: THREADS_LINK
        views.setOnClickPendingIntent(row, open(context, i + 1, link))
      }
      return views
    }
  }
}
