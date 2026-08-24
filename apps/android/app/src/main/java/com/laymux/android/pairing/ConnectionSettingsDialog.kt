package com.laymux.android.pairing

import android.view.LayoutInflater
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.materialswitch.MaterialSwitch
import com.laymux.android.R
import com.laymux.android.update.UpdateChannel
import com.laymux.android.update.UpdateSectionStatus
import com.laymux.android.update.labelResId
import com.laymux.android.update.presentUpdateSection
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

interface ConnectionSettingsActions {
    fun setBiometricRequired(required: Boolean)
    fun verifyPairingProtection(instanceId: String)
    fun retryPairingConfirmation(instanceId: String)
    fun forgetPairing(instanceId: String)
    fun dismissConnectionSettings()

    /** 채널 변경은 즉시 1회 확인을 트리거한다 (ADR-0197). */
    fun setUpdateChannel(channel: UpdateChannel)

    /** 수동 확인은 주기 throttle 을 무시한다. */
    fun checkForUpdate()

    fun openReleasePage(url: String)
}

class ConnectionSettingsDialog(
    private val activity: FragmentActivity,
    private val actions: ConnectionSettingsActions,
) {
    private data class Views(
        val deviceLabel: TextView,
        val instanceId: TextView,
        val endpoint: TextView,
        val pairingStatus: TextView,
        val pairingEmpty: TextView,
        val error: TextView,
        val notice: TextView,
        val pairingActions: View,
        val retry: MaterialButton,
        val verify: MaterialButton,
        val forget: MaterialButton,
        val biometricSwitch: MaterialSwitch,
        val biometricHint: TextView,
        val updateCurrentVersion: TextView,
        val updateStatus: TextView,
        val updateLastChecked: TextView,
        val updateBetaSwitch: MaterialSwitch,
        val updateChannelHint: TextView,
        val updateCheck: MaterialButton,
        val updateOpenRelease: MaterialButton,
    )

    private var dialog: AlertDialog? = null
    private var views: Views? = null

    val isShowing: Boolean
        get() = dialog?.isShowing == true

    fun show(state: ConnectionSettingsState) {
        if (isShowing) {
            render(state)
            return
        }
        val content = LayoutInflater.from(activity).inflate(
            R.layout.connection_settings_dialog,
            FrameLayout(activity),
            false,
        )
        val nextDialog = MaterialAlertDialogBuilder(activity)
            .setTitle(R.string.connection_settings_title)
            .setView(content)
            .setNegativeButton(R.string.connection_settings_close, null)
            .create()
        views = bind(content)
        dialog = nextDialog
        render(state)
        nextDialog.setOnDismissListener {
            if (dialog === nextDialog) {
                dialog = null
                views = null
                actions.dismissConnectionSettings()
            }
        }
        nextDialog.show()
    }

    fun render(state: ConnectionSettingsState) {
        val bound = views ?: return
        val presentation = presentConnectionSettings(state)
        val pairing = state.pairing

        bound.deviceLabel.text = pairing?.label ?: activity.getString(
            R.string.connection_settings_device_fallback,
        )
        bound.instanceId.text = state.instanceId
        bound.endpoint.text = pairing?.endpoint.orEmpty()
        bound.endpoint.visibility = if (pairing == null) View.GONE else View.VISIBLE
        bound.pairingStatus.text = activity.getString(
            when (presentation.status) {
                ConnectionPairingStatus.NOT_PAIRED -> R.string.connection_settings_status_not_paired
                ConnectionPairingStatus.PENDING -> R.string.pairing_status_confirmation_pending
                ConnectionPairingStatus.CONFIRMED -> R.string.pairing_status_confirmed
            },
        )
        bound.pairingStatus.setTextColor(
            ContextCompat.getColor(
                activity,
                if (presentation.status == ConnectionPairingStatus.CONFIRMED) {
                    R.color.laymux_notice
                } else {
                    R.color.laymux_primary
                },
            ),
        )
        bound.pairingEmpty.visibility = if (pairing == null) View.VISIBLE else View.GONE
        showText(bound.error, state.error)
        showText(bound.notice, state.notice)
        renderPairingActions(bound, state, presentation)
        renderProtection(bound, state)
        renderUpdate(bound, state)
    }

    fun dismiss() {
        val current = dialog ?: return
        current.setOnDismissListener(null)
        current.dismiss()
        if (dialog === current) {
            dialog = null
            views = null
        }
    }

    private fun bind(content: View): Views = Views(
        deviceLabel = content.findViewById(R.id.connection_settings_device_label),
        instanceId = content.findViewById(R.id.connection_settings_instance_id),
        endpoint = content.findViewById(R.id.connection_settings_endpoint),
        pairingStatus = content.findViewById(R.id.connection_settings_pairing_status),
        pairingEmpty = content.findViewById(R.id.connection_settings_pairing_empty),
        error = content.findViewById(R.id.connection_settings_error),
        notice = content.findViewById(R.id.connection_settings_notice),
        pairingActions = content.findViewById(R.id.connection_settings_pairing_actions),
        retry = content.findViewById(R.id.connection_settings_retry),
        verify = content.findViewById(R.id.connection_settings_verify),
        forget = content.findViewById(R.id.connection_settings_forget),
        biometricSwitch = content.findViewById(R.id.connection_settings_biometric_switch),
        biometricHint = content.findViewById(R.id.connection_settings_biometric_hint),
        updateCurrentVersion = content.findViewById(R.id.update_section_current_version),
        updateStatus = content.findViewById(R.id.update_section_status),
        updateLastChecked = content.findViewById(R.id.update_section_last_checked),
        updateBetaSwitch = content.findViewById(R.id.update_section_beta_switch),
        updateChannelHint = content.findViewById(R.id.update_section_channel_hint),
        updateCheck = content.findViewById(R.id.update_section_check),
        updateOpenRelease = content.findViewById(R.id.update_section_open_release),
    )

    private fun renderPairingActions(
        bound: Views,
        state: ConnectionSettingsState,
        presentation: ConnectionSettingsPresentation,
    ) {
        bound.pairingActions.visibility = if (
            presentation.retryVisible || presentation.verifyVisible || presentation.forgetVisible
        ) View.VISIBLE else View.GONE
        bound.retry.apply {
            visibility = if (presentation.retryVisible) View.VISIBLE else View.GONE
            isEnabled = presentation.retryEnabled
            setOnClickListener {
                isEnabled = false
                actions.retryPairingConfirmation(state.instanceId)
            }
        }
        bound.verify.apply {
            visibility = if (presentation.verifyVisible) View.VISIBLE else View.GONE
            isEnabled = presentation.verifyEnabled
            setOnClickListener {
                isEnabled = false
                actions.verifyPairingProtection(state.instanceId)
            }
        }
        bound.forget.apply {
            visibility = if (presentation.forgetVisible) View.VISIBLE else View.GONE
            isEnabled = presentation.forgetVisible
            setOnClickListener {
                isEnabled = false
                actions.forgetPairing(state.instanceId)
            }
        }
    }

    private fun renderProtection(bound: Views, state: ConnectionSettingsState) {
        val biometricRequired = state.protectionPolicy == PairingProtectionPolicy.BIOMETRIC
        bound.biometricSwitch.setOnCheckedChangeListener(null)
        bound.biometricSwitch.isChecked = biometricRequired
        bound.biometricSwitch.isEnabled = true
        bound.biometricSwitch.setOnCheckedChangeListener { button, required ->
            button.isEnabled = false
            actions.setBiometricRequired(required)
        }
        val unavailable = biometricRequired &&
            state.biometricAvailability != BiometricAvailability.AVAILABLE
        bound.biometricHint.text = when {
            unavailable -> activity.getString(
                R.string.pairing_protection_unavailable,
                state.biometricAvailability.userMessage
                    ?: activity.getString(R.string.pairing_title_protection_required),
            )
            biometricRequired -> activity.getString(R.string.pairing_protection_default)
            else -> activity.getString(R.string.pairing_protection_keystore_only)
        }
        bound.biometricHint.setTextColor(
            ContextCompat.getColor(
                activity,
                if (unavailable) R.color.laymux_error else R.color.laymux_on_surface_variant,
            ),
        )
    }

    /**
     * 업데이트 섹션 (ADR-0197). 상태 판정은 [presentUpdateSection] 이 하고 여기는
     * 문안과 리스너만 붙인다.
     */
    private fun renderUpdate(bound: Views, state: ConnectionSettingsState) {
        val update = presentUpdateSection(state.update)
        bound.updateCurrentVersion.text = activity.getString(
            R.string.update_section_current_version,
            update.currentVersion,
            activity.getString(update.channel.labelResId()),
        )

        val statusText = when (update.status) {
            UpdateSectionStatus.DISABLED -> activity.getString(R.string.update_status_disabled)
            UpdateSectionStatus.CHECKING -> activity.getString(R.string.update_status_checking)
            UpdateSectionStatus.AVAILABLE -> activity.getString(
                R.string.update_status_available,
                update.availableVersion.orEmpty(),
            )
            // 확인 실패를 최신 상태와 같은 표시로 접으면 끊긴 배포 경로를 아무도
            // 알아차리지 못한다.
            UpdateSectionStatus.ERROR -> update.lastError
                ?: activity.getString(R.string.update_status_disabled)
            UpdateSectionStatus.UP_TO_DATE -> activity.getString(R.string.update_status_up_to_date)
            UpdateSectionStatus.NEVER_CHECKED ->
                activity.getString(R.string.update_section_never_checked)
        }
        bound.updateStatus.text = statusText
        bound.updateStatus.setTextColor(
            ContextCompat.getColor(
                activity,
                when (update.status) {
                    UpdateSectionStatus.AVAILABLE -> R.color.laymux_primary
                    UpdateSectionStatus.ERROR -> R.color.laymux_error
                    else -> R.color.laymux_on_surface_variant
                },
            ),
        )

        val lastChecked = update.lastCheckedAtEpochMillis
        bound.updateLastChecked.visibility = if (lastChecked == null) View.GONE else View.VISIBLE
        if (lastChecked != null) {
            bound.updateLastChecked.text = activity.getString(
                R.string.update_section_last_checked,
                SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault()).format(Date(lastChecked)),
            )
        }

        bound.updateBetaSwitch.setOnCheckedChangeListener(null)
        bound.updateBetaSwitch.isChecked = update.channel == UpdateChannel.BETA
        bound.updateBetaSwitch.isEnabled = update.channelChoiceEnabled
        bound.updateBetaSwitch.setOnCheckedChangeListener { _, beta ->
            actions.setUpdateChannel(if (beta) UpdateChannel.BETA else UpdateChannel.STABLE)
        }
        bound.updateChannelHint.setText(
            if (update.betaWarningVisible) {
                R.string.update_channel_hint_beta
            } else {
                R.string.update_channel_hint_stable
            },
        )
        bound.updateChannelHint.setTextColor(
            ContextCompat.getColor(
                activity,
                if (update.betaWarningVisible) {
                    R.color.laymux_error
                } else {
                    R.color.laymux_on_surface_variant
                },
            ),
        )

        bound.updateCheck.isEnabled = update.checkEnabled
        bound.updateCheck.setOnClickListener { actions.checkForUpdate() }
        val releaseUrl = update.releaseUrl
        bound.updateOpenRelease.visibility = if (releaseUrl == null) View.GONE else View.VISIBLE
        bound.updateOpenRelease.setOnClickListener(
            if (releaseUrl == null) null else View.OnClickListener { actions.openReleasePage(releaseUrl) },
        )
    }

    private fun showText(view: TextView, value: String?) {
        view.text = value.orEmpty()
        view.visibility = if (value.isNullOrBlank()) View.GONE else View.VISIBLE
    }
}
