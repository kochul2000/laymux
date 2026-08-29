package com.laymux.android.web

import android.content.Context
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import com.google.android.material.button.MaterialButton
import com.laymux.android.R

/** Native escape hatch that stays available when the Cloud document cannot render. */
internal class CloudLoadOverlayView(
    context: Context,
    retry: () -> Unit,
) : LinearLayout(context) {
    private val progress = ProgressBar(context)
    private val title = TextView(context)
    private val detail = TextView(context)
    private val retryButton = MaterialButton(context)

    init {
        val density = resources.displayMetrics.density
        orientation = VERTICAL
        gravity = Gravity.CENTER
        setPadding(
            (32 * density).toInt(),
            (32 * density).toInt(),
            (32 * density).toInt(),
            (32 * density).toInt(),
        )
        setBackgroundColor(ContextCompat.getColor(context, R.color.laymux_background))
        isClickable = true
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES

        title.apply {
            setTextColor(ContextCompat.getColor(context, R.color.laymux_on_surface))
            textSize = 22f
            gravity = Gravity.CENTER
        }
        ViewCompat.setAccessibilityHeading(title, true)
        detail.apply {
            setTextColor(ContextCompat.getColor(context, R.color.laymux_on_surface_variant))
            textSize = 15f
            gravity = Gravity.CENTER
        }
        retryButton.apply {
            setText(R.string.cloud_load_retry)
            setOnClickListener { retry() }
        }

        addView(
            progress,
            LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT),
        )
        addView(
            title,
            LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
                topMargin = (20 * density).toInt()
            },
        )
        addView(
            detail,
            LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
                topMargin = (10 * density).toInt()
            },
        )
        addView(
            retryButton,
            LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply {
                topMargin = (24 * density).toInt()
            },
        )
        render(CloudDocumentPresentation.LOADING)
    }

    fun render(presentation: CloudDocumentPresentation) {
        when (presentation) {
            CloudDocumentPresentation.LOADING -> {
                progress.visibility = View.VISIBLE
                title.setText(R.string.cloud_load_loading_title)
                detail.setText(R.string.cloud_load_loading_detail)
                retryButton.visibility = View.GONE
            }
            CloudDocumentPresentation.UNAVAILABLE -> {
                progress.visibility = View.GONE
                title.setText(R.string.cloud_load_error_title)
                detail.setText(R.string.cloud_load_error_detail)
                retryButton.visibility = View.VISIBLE
            }
            CloudDocumentPresentation.READY -> Unit
        }
    }
}
