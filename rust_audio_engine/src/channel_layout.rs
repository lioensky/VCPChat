//! Channel layout metadata: positional channel roles and standard layouts.
//!
//! This module defines [`ChannelPosition`] (a speaker role) and
//! [`ChannelLayout`] (an *ordered* set of roles). It is a pure, dependency-free
//! core primitive: it carries no DSP and touches no audio-callback hot path.
//! The decoder populates a layout from the container's channel mask, the
//! [`crate::processor::Downmixer`] consumes it to build a mixing matrix, and the
//! loudness meter consumes it to weight channels per EBU R128.
//!
//! # Channel-order contract
//!
//! Interleaved audio in this crate is laid out frame-major:
//! `[ch0, ch1, ..., ch(N-1), ch0, ch1, ...]`. A [`ChannelLayout`]'s
//! [`positions`](ChannelLayout::positions) slice is the source of truth for
//! *which speaker each interleaved slot belongs to*: interleaved channel `i`
//! carries [`ChannelPosition`] `positions()[i]`. The decoder derives this order
//! from the container (Symphonia yields channels in ascending channel-mask bit
//! order, e.g. `FL, FR, FC, LFE, RL, RR, SL, SR`), so the standard layouts
//! produced by [`ChannelLayout::from_count`] match that convention.
//!
//! Downstream code must not assume a fixed order beyond what `positions()`
//! reports — that is the whole point of carrying an explicit layout rather than
//! a bare channel count.

/// A single speaker position / channel role.
///
/// Variants are limited to the positions this crate maps for layout-aware
/// loudness weighting and stereo/mono downmix. Positions it cannot classify
/// (e.g. height channels, or discrete channels beyond a known layout) use
/// [`ChannelPosition::Unspecified`], which is excluded from loudness weighting
/// and dropped by downmix rather than guessed at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChannelPosition {
    /// Front left (ITU M+030).
    FrontLeft,
    /// Front right (ITU M-030).
    FrontRight,
    /// Front center (ITU M+000). Also used to represent a mono channel.
    FrontCenter,
    /// Low-frequency effects (LFE). Excluded from EBU R128 weighting.
    LowFrequency,
    /// Rear/back left surround (ITU M+110).
    RearLeft,
    /// Rear/back right surround (ITU M-110).
    RearRight,
    /// Side left surround.
    SideLeft,
    /// Side right surround.
    SideRight,
    /// Front left-of-center.
    FrontLeftCenter,
    /// Front right-of-center.
    FrontRightCenter,
    /// Rear center (ITU M+180).
    RearCenter,
    /// A channel with no role this crate classifies. Not weighted for loudness;
    /// dropped by downmix.
    Unspecified,
}

impl ChannelPosition {
    /// True for the LFE channel.
    pub fn is_lfe(self) -> bool {
        matches!(self, ChannelPosition::LowFrequency)
    }

    /// True for surround (rear/side) positions that receive the EBU R128
    /// +1.5 dB surround weighting.
    pub fn is_surround(self) -> bool {
        matches!(
            self,
            ChannelPosition::RearLeft
                | ChannelPosition::RearRight
                | ChannelPosition::SideLeft
                | ChannelPosition::SideRight
        )
    }
}

/// An ordered set of channel positions describing one audio stream's layout.
///
/// The order of [`positions`](Self::positions) is the interleave order (see the
/// [module docs](self) for the channel-order contract). Construct via the named
/// helpers ([`stereo`](Self::stereo), [`surround_5_1`](Self::surround_5_1), …),
/// from a raw count via [`from_count`](Self::from_count), or from an explicit
/// position list via [`from_positions`](Self::from_positions).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ChannelLayout {
    positions: Vec<ChannelPosition>,
}

impl ChannelLayout {
    /// Build a layout from an explicit, ordered list of positions.
    pub fn from_positions(positions: impl Into<Vec<ChannelPosition>>) -> Self {
        Self {
            positions: positions.into(),
        }
    }

    /// Mono: a single front-center channel.
    pub fn mono() -> Self {
        Self::from_positions([ChannelPosition::FrontCenter])
    }

    /// Stereo: front left + front right.
    pub fn stereo() -> Self {
        Self::from_positions([ChannelPosition::FrontLeft, ChannelPosition::FrontRight])
    }

    /// 5.1 surround in the standard `L R C LFE Ls Rs` order.
    pub fn surround_5_1() -> Self {
        Self::from_positions([
            ChannelPosition::FrontLeft,
            ChannelPosition::FrontRight,
            ChannelPosition::FrontCenter,
            ChannelPosition::LowFrequency,
            ChannelPosition::RearLeft,
            ChannelPosition::RearRight,
        ])
    }

    /// 7.1 surround in the standard `L R C LFE Ls Rs Lb/SL Rb/SR` order.
    ///
    /// Channels 4–5 are the rear surrounds and channels 6–7 the side
    /// surrounds; all four receive the EBU R128 surround weighting.
    pub fn surround_7_1() -> Self {
        Self::from_positions([
            ChannelPosition::FrontLeft,
            ChannelPosition::FrontRight,
            ChannelPosition::FrontCenter,
            ChannelPosition::LowFrequency,
            ChannelPosition::RearLeft,
            ChannelPosition::RearRight,
            ChannelPosition::SideLeft,
            ChannelPosition::SideRight,
        ])
    }

    /// Best-effort standard layout for a bare channel count.
    ///
    /// Counts 1–8 map to the conventional consumer layouts (matching the
    /// Symphonia / WAV channel order). A count above 8 places the first eight
    /// per the 7.1 template and marks the remainder
    /// [`Unspecified`](ChannelPosition::Unspecified). A count of 0 yields an
    /// empty layout.
    pub fn from_count(channels: usize) -> Self {
        use ChannelPosition::*;
        let positions: Vec<ChannelPosition> = match channels {
            0 => Vec::new(),
            1 => vec![FrontCenter],
            2 => vec![FrontLeft, FrontRight],
            3 => vec![FrontLeft, FrontRight, FrontCenter],
            4 => vec![FrontLeft, FrontRight, RearLeft, RearRight],
            5 => vec![FrontLeft, FrontRight, FrontCenter, RearLeft, RearRight],
            6 => vec![
                FrontLeft,
                FrontRight,
                FrontCenter,
                LowFrequency,
                RearLeft,
                RearRight,
            ],
            7 => vec![
                FrontLeft,
                FrontRight,
                FrontCenter,
                LowFrequency,
                RearLeft,
                RearRight,
                RearCenter,
            ],
            8 => vec![
                FrontLeft,
                FrontRight,
                FrontCenter,
                LowFrequency,
                RearLeft,
                RearRight,
                SideLeft,
                SideRight,
            ],
            n => {
                let mut v = Self::surround_7_1().positions;
                v.extend(std::iter::repeat_n(Unspecified, n - 8));
                v
            }
        };
        Self { positions }
    }

    /// The ordered positions; interleaved channel `i` carries `positions()[i]`.
    pub fn positions(&self) -> &[ChannelPosition] {
        &self.positions
    }

    /// Number of channels in this layout.
    pub fn channel_count(&self) -> usize {
        self.positions.len()
    }

    /// True if the layout has no channels.
    pub fn is_empty(&self) -> bool {
        self.positions.is_empty()
    }

    /// Index of the first channel with the given position, if present.
    pub fn index_of(&self, position: ChannelPosition) -> Option<usize> {
        self.positions.iter().position(|&p| p == position)
    }

    /// True if the layout contains the given position.
    pub fn contains(&self, position: ChannelPosition) -> bool {
        self.positions.contains(&position)
    }

    /// True if the layout has an LFE channel.
    pub fn has_lfe(&self) -> bool {
        self.positions.iter().any(|p| p.is_lfe())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_counts_match_named_layouts() {
        assert_eq!(ChannelLayout::from_count(1), ChannelLayout::mono());
        assert_eq!(ChannelLayout::from_count(2), ChannelLayout::stereo());
        assert_eq!(ChannelLayout::from_count(6), ChannelLayout::surround_5_1());
        assert_eq!(ChannelLayout::from_count(8), ChannelLayout::surround_7_1());
    }

    #[test]
    fn counts_have_expected_channel_count() {
        for n in 0..=10 {
            assert_eq!(ChannelLayout::from_count(n).channel_count(), n);
        }
    }

    #[test]
    fn surround_layouts_report_lfe_and_surround_roles() {
        let l = ChannelLayout::surround_5_1();
        assert!(l.has_lfe());
        assert_eq!(l.index_of(ChannelPosition::LowFrequency), Some(3));
        assert!(l.contains(ChannelPosition::RearLeft));
        assert!(ChannelPosition::RearLeft.is_surround());
        assert!(!ChannelPosition::FrontLeft.is_surround());

        let stereo = ChannelLayout::stereo();
        assert!(!stereo.has_lfe());
    }

    #[test]
    fn counts_above_eight_pad_with_unspecified() {
        let l = ChannelLayout::from_count(10);
        assert_eq!(l.channel_count(), 10);
        assert_eq!(l.positions()[8], ChannelPosition::Unspecified);
        assert_eq!(l.positions()[9], ChannelPosition::Unspecified);
    }
}
