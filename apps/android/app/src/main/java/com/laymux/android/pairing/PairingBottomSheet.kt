package com.laymux.android.pairing

import android.content.res.ColorStateList
import android.view.LayoutInflater
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import androidx.appcompat.content.res.AppCompatResources
import androidx.fragment.app.FragmentActivity
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.button.MaterialButton
import com.laymux.android.R

interface PairingSheetActions {
    fun scanPairingQr()
    fun pastePairingValue()
    fun openConnectionSettings(instanceId: String)
    fun connectRemote()
    fun cancelRemoteConnection()
    fun disconnectRemote()
    fun dismissPairing()
}

class PairingBottomSheet(
    private val activity: FragmentActivity,
    private val actions: PairingSheetActions,
) {
    private data class Views(
        val statusBadge: TextView,
        val title: TextView,
        val description: TextView,
        val error: TextView,
        val notice: TextView,
        val remoteSection: View,
        val connectButton: MaterialButton,
        val defaultConnectBackgroundTint: ColorStateList?,
        val defaultConnectTextColors: ColorStateList,
        val scanButton: MaterialButton,
        val pasteButton: MaterialButton,
        val defaultScanTextColors: ColorStateList,
        val defaultScanStrokeColor: ColorStateList?,
        val defaultScanRippleColor: ColorStateList?,
        val cancelButton: MaterialButton,
    )

    private var dialog: BottomSheetDialog? = null
    private var views: Views? = null
    val isShowing: Boolean
        get() = dialog?.isShowing == true

    fun show(state: PairingSheetState) {
        if (isShowing) {
            render(state)
            return
        }
        val content = LayoutInflater.from(activity).inflate(
            R.layout.pairing_bottom_sheet,
            FrameLayout(activity),
            false,
        )
        val nextDialog = BottomSheetDialog(activity).apply {
            setContentView(content)
            setCancelable(true)
            setCanceledOnTouchOutside(true)
            dismissWithAnimation = true
        }
        views = bind(content)
        dialog = nextDialog
        bindStaticActions(nextDialog)
        render(state)
        nextDialog.setOnShowListener {
            nextDialog.behavior.apply {
                isFitToContents = true
                skipCollapsed = true
                isHideable = true
                isDraggable = true
                this.state = BottomSheetBehavior.STATE_EXPANDED
            }
        }
        nextDialog.setOnCancelListener { actions.dismissPairing() }
        nextDialog.setOnDismissListener {
            if (dialog === nextDialog) {
                dialog = null
                views = null
            }
        }
        nextDialog.show()
    }

    fun render(state: PairingSheetState) {
        val bound = views ?: return
        val presentation = presentPairingSheet(state)

        renderStatus(bound, state, presentation)
        renderMessages(bound, state)
        renderRemote(bound, presentation)
        renderScan(bound, state, presentation)
    }

    fun dismiss() {
        val current = dialog ?: return
        current.setOnCancelListener(null)
        current.dismiss()
    }

    private fun bind(content: View): Views {
        val scanButton = content.findViewById<MaterialButton>(R.id.pairing_scan_button)
        val connectButton = content.findViewById<MaterialButton>(R.id.pairing_connect_button)
        return Views(
            statusBadge = content.findViewById(R.id.pairing_status_badge),
            title = content.findViewById(R.id.pairing_state_title),
            description = content.findViewById(R.id.pairing_state_description),
            error = content.findViewById(R.id.pairing_error),
            notice = content.findViewById(R.id.pairing_notice),
            remoteSection = content.findViewById(R.id.pairing_remote_section),
            connectButton = connectButton,
            defaultConnectBackgroundTint = connectButton.backgroundTintList,
            defaultConnectTextColors = connectButton.textColors,
            scanButton = scanButton,
            pasteButton = content.findViewById(R.id.pairing_paste_button),
            defaultScanTextColors = scanButton.textColors,
            defaultScanStrokeColor = scanButton.strokeColor,
            defaultScanRippleColor = scanButton.rippleColor,
            cancelButton = content.findViewById(R.id.pairing_cancel_button),
        )
    }

    private fun bindStaticActions(sheetDialog: BottomSheetDialog) {
        val bound = requireNotNull(views)
        bound.cancelButton.setOnClickListener { sheetDialog.cancel() }
    }

    private fun renderStatus(
        bound: Views,
        state: PairingSheetState,
        presentation: PairingSheetPresentation,
    ) {
        bound.statusBadge.text = when (presentation.status) {
            PairingStatusKind.PROTECTION_REQUIRED ->
                activity.getString(R.string.pairing_status_protection_required)
            PairingStatusKind.CONFIRMED ->
                activity.getString(R.string.pairing_status_confirmed)
            PairingStatusKind.CONFIRMATION_PENDING ->
                activity.getString(R.string.pairing_status_confirmation_pending)
            PairingStatusKind.SAVED_PAIRINGS -> activity.getString(
                R.string.pairing_status_saved_count,
                state.pairings.size,
            )
            PairingStatusKind.PAIRING_REQUIRED ->
                activity.getString(R.string.pairing_status_required)
        }
        bound.title.text = activity.getString(
            when (presentation.status) {
                PairingStatusKind.PROTECTION_REQUIRED -> R.string.pairing_title_protection_required
                PairingStatusKind.CONFIRMED -> R.string.pairing_title_confirmed
                PairingStatusKind.CONFIRMATION_PENDING ->
                    R.string.pairing_title_confirmation_pending
                PairingStatusKind.SAVED_PAIRINGS,
                PairingStatusKind.PAIRING_REQUIRED,
                -> if (state.selectedInstanceId != null) {
                    R.string.pairing_title_scan
                } else {
                    R.string.pairing_title_select
                }
            },
        )
        bound.description.text = activity.getString(
            when (presentation.description) {
                PairingDescriptionKind.PROTECTION_REQUIRED ->
                    R.string.pairing_description_protection_required
                PairingDescriptionKind.CONFIRMED_BIOMETRIC ->
                    R.string.pairing_description_confirmed_biometric
                PairingDescriptionKind.CONFIRMED_KEYSTORE_ONLY ->
                    R.string.pairing_description_confirmed_keystore
                PairingDescriptionKind.CONFIRMATION_PENDING ->
                    R.string.pairing_description_confirmation_pending
                PairingDescriptionKind.SCAN_SELECTED -> R.string.pairing_description_scan
                PairingDescriptionKind.SAVED_PAIRINGS -> R.string.pairing_description_saved
                PairingDescriptionKind.SELECT_PC -> R.string.pairing_description_select
            },
        )
    }

    private fun renderMessages(bound: Views, state: PairingSheetState) {
        showText(bound.error, state.error)
        showText(bound.notice, state.notice)
    }

    private fun showText(view: TextView, value: String?) {
        view.text = value.orEmpty()
        view.visibility = if (value.isNullOrBlank()) View.GONE else View.VISIBLE
    }

    private fun renderRemote(bound: Views, presentation: PairingSheetPresentation) {
        bound.remoteSection.visibility = if (
            presentation.connectAction == PairingConnectAction.HIDDEN
        ) View.GONE else View.VISIBLE
        bound.connectButton.isEnabled = presentation.connectEnabled
        bound.connectButton.text = activity.getString(
            when (presentation.connectAction) {
                PairingConnectAction.HIDDEN,
                PairingConnectAction.CONNECT,
                -> R.string.pairing_connect
                PairingConnectAction.CANCEL -> R.string.pairing_connect_cancel
                PairingConnectAction.DISCONNECT -> R.string.pairing_disconnect
            },
        )
        renderConnectEmphasis(bound, presentation.connectAction)
        bound.connectButton.setOnClickListener {
            bound.connectButton.isEnabled = false
            when (presentation.connectAction) {
                PairingConnectAction.CONNECT -> actions.connectRemote()
                PairingConnectAction.CANCEL -> actions.cancelRemoteConnection()
                PairingConnectAction.DISCONNECT -> actions.disconnectRemote()
                PairingConnectAction.HIDDEN -> Unit
            }
        }
    }

    // "연결 취소"(CANCEL) is a mid-connect abort, not the promoted action, so it
    // drops from the filled primary look to a neutral tonal one — distinct from
    // both the primary CONNECT and the text-button "취소" below it. CONNECT and
    // DISCONNECT keep the default filled primary.
    private fun renderConnectEmphasis(bound: Views, action: PairingConnectAction) {
        if (action == PairingConnectAction.CANCEL) {
            // Stateful CSLs so a momentarily-disabled CANCEL button dims like the
            // default filled button does, instead of staying fully opaque.
            bound.connectButton.backgroundTintList = AppCompatResources.getColorStateList(
                activity,
                R.color.pairing_connect_cancel_bg,
            )
            bound.connectButton.setTextColor(
                requireNotNull(
                    AppCompatResources.getColorStateList(
                        activity,
                        R.color.pairing_rescan_text,
                    ),
                ),
            )
            return
        }
        bound.connectButton.backgroundTintList = bound.defaultConnectBackgroundTint
        bound.connectButton.setTextColor(bound.defaultConnectTextColors)
    }

    private fun renderScan(
        bound: Views,
        state: PairingSheetState,
        presentation: PairingSheetPresentation,
    ) {
        bound.scanButton.visibility = if (
            presentation.scanAction == PairingScanAction.HIDDEN
        ) View.GONE else View.VISIBLE
        bound.scanButton.isEnabled = presentation.scanEnabled
        val pasteAvailable = presentation.scanAction == PairingScanAction.SCAN ||
            presentation.scanAction == PairingScanAction.RESCAN
        bound.pasteButton.visibility = if (pasteAvailable) View.VISIBLE else View.GONE
        bound.pasteButton.isEnabled = presentation.scanEnabled
        bound.scanButton.text = activity.getString(
            when (presentation.scanAction) {
                PairingScanAction.HIDDEN,
                PairingScanAction.SCAN,
                -> R.string.pairing_scan
                PairingScanAction.OPEN_SETTINGS -> R.string.pairing_open_protection
                PairingScanAction.RESCAN -> R.string.pairing_rescan
            },
        )
        renderScanEmphasis(bound, presentation.scanEmphasis)
        bound.scanButton.setOnClickListener {
            when (presentation.scanAction) {
                PairingScanAction.OPEN_SETTINGS -> state.selectedInstanceId?.let {
                    actions.openConnectionSettings(it)
                }
                PairingScanAction.SCAN,
                PairingScanAction.RESCAN,
                -> {
                    bound.scanButton.isEnabled = false
                    bound.pasteButton.isEnabled = false
                    actions.scanPairingQr()
                }
                PairingScanAction.HIDDEN -> Unit
            }
        }
        bound.pasteButton.setOnClickListener {
            bound.scanButton.isEnabled = false
            bound.pasteButton.isEnabled = false
            actions.pastePairingValue()
        }
    }

    private fun renderScanEmphasis(bound: Views, emphasis: PairingScanEmphasis) {
        if (emphasis == PairingScanEmphasis.NEUTRAL) {
            listOf(bound.scanButton, bound.pasteButton).forEach { button ->
                button.setTextColor(
                    requireNotNull(
                        AppCompatResources.getColorStateList(
                            activity,
                            R.color.pairing_rescan_text,
                        ),
                    ),
                )
                button.strokeColor = AppCompatResources.getColorStateList(
                    activity,
                    R.color.pairing_rescan_stroke,
                )
                button.rippleColor = AppCompatResources.getColorStateList(
                    activity,
                    R.color.pairing_rescan_ripple,
                )
            }
            return
        }
        listOf(bound.scanButton, bound.pasteButton).forEach { button ->
            button.setTextColor(bound.defaultScanTextColors)
            button.strokeColor = bound.defaultScanStrokeColor
            button.rippleColor = bound.defaultScanRippleColor
        }
    }
}
