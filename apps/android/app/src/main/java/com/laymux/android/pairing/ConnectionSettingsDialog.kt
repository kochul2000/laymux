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

interface ConnectionSettingsActions {
    fun setBiometricRequired(required: Boolean)
    fun verifyPairingProtection(instanceId: String)
    fun retryPairingConfirmation(instanceId: String)
    fun forgetPairing(instanceId: String)
    fun dismissConnectionSettings()
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

    private fun showText(view: TextView, value: String?) {
        view.text = value.orEmpty()
        view.visibility = if (value.isNullOrBlank()) View.GONE else View.VISIBLE
    }
}
