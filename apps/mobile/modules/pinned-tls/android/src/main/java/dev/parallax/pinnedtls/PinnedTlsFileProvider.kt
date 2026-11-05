package dev.parallax.pinnedtls

import androidx.core.content.FileProvider

/** Its own class, as a manifest merges providers of one class into one (`preview`). */
class PinnedTlsFileProvider : FileProvider()
