package com.laymux.android.update

import android.app.Activity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import com.google.android.material.button.MaterialButton
import com.laymux.android.R

/** 배너가 사용자에게 줄 수 있는 두 동작. */
interface UpdateBannerActions {
    fun openReleasePage(url: String)

    fun dismissUpdateBanner()
}

/**
 * 업데이트 배너의 뷰 바인딩 (ADR-0197). 표시 여부와 문안 재료는 전부
 * [presentUpdateBanner] 가 정하고, 이 클래스는 그 결과를 뷰에 옮기기만 한다.
 */
class UpdateBannerView(
    activity: Activity,
    parent: ViewGroup,
    private val actions: UpdateBannerActions,
) {
    private val root: View = LayoutInflater.from(activity)
        .inflate(R.layout.update_banner, parent, false)
    private val title: TextView = root.findViewById(R.id.update_banner_title)
    private val detail: TextView = root.findViewById(R.id.update_banner_detail)
    private val open: MaterialButton = root.findViewById(R.id.update_banner_open)
    private val dismiss: MaterialButton = root.findViewById(R.id.update_banner_dismiss)

    val view: View get() = root

    init {
        dismiss.setOnClickListener { actions.dismissUpdateBanner() }
    }

    fun render(state: UpdateState) {
        val presentation = presentUpdateBanner(state)
        root.visibility = if (presentation.visible) View.VISIBLE else View.GONE
        val version = presentation.version
        val releaseUrl = presentation.releaseUrl
        if (!presentation.visible || version == null || releaseUrl == null) {
            // 후보 없이 남은 클릭 리스너가 옛 URL 을 열지 못하게 한다.
            open.setOnClickListener(null)
            return
        }
        val context = root.context
        title.text = context.getString(R.string.update_banner_title, version)
        detail.text = context.getString(
            R.string.update_banner_detail,
            context.getString(presentation.channel.labelResId()),
            state.currentVersion,
        )
        open.setOnClickListener { actions.openReleasePage(releaseUrl) }
    }
}

/** 어느 계열을 따라가는 중인지 모르면 사용자는 자기가 받은 버전을 해석할 수 없다. */
fun UpdateChannel.labelResId(): Int = when (this) {
    UpdateChannel.STABLE -> R.string.update_channel_stable
    UpdateChannel.BETA -> R.string.update_channel_beta
}
