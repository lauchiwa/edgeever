// Single source of truth for this fork's identity (lauchiwa/edgeever).
// Upstream files import from here so an upstream sync touches one import line,
// not scattered literals. scripts/fork-invariants.test.mjs fails if any of
// these drift back to upstream, or if a new upstream literal appears.
// Mirror: packages/shared/src/fork-config.ts (renderer). Keep both identical.

export const FORK_REPOSITORY = "lauchiwa/edgeever";
export const FORK_REPOSITORY_URL = `https://github.com/${FORK_REPOSITORY}`;
// GitHub's /releases/latest excludes pre-releases, and every fork release is
// one (vX.Y.Z-rc.N), so links use the release list, never /releases/latest.
export const FORK_RELEASES_URL = `${FORK_REPOSITORY_URL}/releases`;
export const FORK_NEW_ISSUE_URL = `${FORK_REPOSITORY_URL}/issues/new`;

// X.Y.Z = upstream version synced from; N = this fork's releases on top of it.
// A bare X.Y.Z is never published: SemVer ranks it above every X.Y.Z-rc.N, and
// a custom "rc" channel is isolated in electron-updater (alpha/beta also accept
// stable releases). See docs/fork-releases.md.
export const FORK_RELEASE_CHANNEL = "rc";
export const FORK_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)-rc\.(0|[1-9]\d*)$/;

// Ed25519 public keys trusted for latest-windows.json. The private keys never
// enter this repository or GitHub Actions; they are generated and kept offline
// by scripts/fork-generate-update-keys.mjs. Primary signs releases; backup is
// kept cold and only signs a key-rotation release if the primary is lost or
// leaked. Fingerprints are SHA-256 of the SPKI DER. Changing either key
// orphans every installed client that pins only the old pair.
export const FORK_WINDOWS_UPDATE_KEYS = Object.freeze({
  primary: Object.freeze({
    keyId: "lauchiwa-edgeever-windows-update-2026-10-a",
    // sha256: 1a383c020d4df0d48d77a715bee892e9c90527baf1ffb5d60172c2b8b46767a0
    publicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAKrzZXf12CFUZpHgx35ShTJfzX6pMD4QtvAmlrC9a5AA=
-----END PUBLIC KEY-----`,
  }),
  backup: Object.freeze({
    keyId: "lauchiwa-edgeever-windows-update-2026-10-b",
    // sha256: 22c1cb666119ae2907c7111083c346079907f67caf8621bc220748b703106f7d
    publicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAUe8UoX4j9K60H/bX41H4xpZcCRKVR+Gt8kVmg4d+Dys=
-----END PUBLIC KEY-----`,
  }),
});

// macOS: without an Apple Developer ID, releases are signed with self-signed
// code-signing certificates generated offline by
// scripts/fork-generate-macos-signing-certificates.mjs. Squirrel.Mac installs
// an update only if it satisfies the running app's designated requirement,
// which pins this bundle id and the SHA-1 of either certificate (primary signs
// releases; backup stays cold for a rotation). Changing both orphans every
// installed client. The bundle id stays upstream's, so upstream builds and
// fork builds refuse each other's updates (their requirements differ).
export const FORK_MACOS_BUNDLE_ID = "org.edgeever.desktop";
export const FORK_MACOS_SIGNING_CERTIFICATES = Object.freeze({
  primary: Object.freeze({
    // sha1: 5defb7db851af5c3e16f6e4c4b6f1ee625e2c62d
    // sha256: f34e8c59b1bab815883aad9e2e1c9fa66c5381898a50ae8a4f5dea8a0e0a034a
    certificatePem: `-----BEGIN CERTIFICATE-----
MIIEUTCCArmgAwIBAgIQYbHVsFdymCuMJHzdRsPR+TANBgkqhkiG9w0BAQsFADA4
MTYwNAYDVQQDDC1FZGdlRXZlciBGb3JrIENvZGUgU2lnbmluZyAobGF1Y2hpd2Ep
IHByaW1hcnkwHhcNMjYxMDE5MTQyMDE1WhcNNDYxMDE5MTUyMDE1WjA4MTYwNAYD
VQQDDC1FZGdlRXZlciBGb3JrIENvZGUgU2lnbmluZyAobGF1Y2hpd2EpIHByaW1h
cnkwggGiMA0GCSqGSIb3DQEBAQUAA4IBjwAwggGKAoIBgQCzHeNxzIFgbPJ7Z1sg
rM3S5ZpcWq/ZJzg+rv3mhubDTYiiULui/6wZw/uyTj3AcrbUpKlHiAvbw0/rjhW0
gbiG9BiS8bZyC2batG2QypB32zXISriBb/6EjJkx4O8uo1OgM+tg1zpLoVrBfvvh
we4Zm+BSh9PPJpA3x5p1fu0jQqaTPZkiojDP7kB0oyr07f6zTugVoHmE9Z7Eqnwb
AYnh+ShJadT0/zdjb+RC4B+tnIGBPBKdbstRlglaKt2QqZEEwb5coi5gqSGy59ye
y0bmMBArSZg3UC+34V1WcdTc/nVGPRQx8j8TXD3a2u0YXCHXNlk8NNlcxQkBC6Fc
1LD2sTeErhSq4/1DrwKBMPrBH7ffFM1xFgdf5ldkSx84NehO4W3mLtJbThRmRzHy
FK7Wd/zLcJh4u7Mk0RFkNNFOSIfU+xy1kvc12+ztaW/RTDs3BdZ4x8UTPyeGNfu4
BGVO3+JugTAWUV6AHPGzTuxWbiW+YSqO9xQxwLUd8RQ81y8CAwEAAaNXMFUwDAYD
VR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCAIAwFgYDVR0lAQH/BAwwCgYIKwYBBQUH
AwMwHQYDVR0OBBYEFCCc0+ewRMTfV3FvKY9MTHpI8JFqMA0GCSqGSIb3DQEBCwUA
A4IBgQCWQgSt0I/aii59kbcE4EpSdxV2moVX53WwSKT2F7sWkSMOkrIjZS0K7btk
94vfGfVn6Xvb9QH4L/QYQDJrg/81zo2UuuZ0+NaaYTZcbAZlbyP2P858rUSXoB1a
oJ3r1sKubdqVsuijutAvJ7UGhRggbOOAUENEj5l4KETKibfs9bRcTehpDFGbSR/O
OsMG5ty2RUcUZVzZHWjRASkqjCoPVQ7N06+NVzlffsVBnC+gKG/MB1Im8qmz8Rm4
mQW2YhnAVKrIenn69tF6Td9oTODF0kxuiV361Eu7jtkOLP/6q+BhNJHdDHk0u30r
+EsLb11TPwvs1SgPa6m0oI0zBSOuNUGTnxHRP7RH5r8N3Mfa/BMRO8CEkc8z8pT5
W+Nf71AcwXTLV5zzTuZgaOGSP1WfpMYQpaIiiuFgszS3LCu2CEvAwGtECrdFT/Cb
4qdzD+4oyv5+Q96dzst7i8vXE8cuHIoXRIK3UUQxL7dLnZa4s5tyV9akjSAbASKe
JVvgUqY=
-----END CERTIFICATE-----`,
  }),
  backup: Object.freeze({
    // sha1: e5b0d87fff7ad337725ae59fa348513c0224c553
    // sha256: 40f56b9529d572c81b4069add55b9ca0861ac58f0740ecb0a81819e3f43d9ef5
    certificatePem: `-----BEGIN CERTIFICATE-----
MIIETzCCAregAwIBAgIQRA+wKAEOq9dAJZr3powUcTANBgkqhkiG9w0BAQsFADA3
MTUwMwYDVQQDDCxFZGdlRXZlciBGb3JrIENvZGUgU2lnbmluZyAobGF1Y2hpd2Ep
IGJhY2t1cDAeFw0yNjEwMTkxNDIwMTVaFw00NjEwMTkxNTIwMTVaMDcxNTAzBgNV
BAMMLEVkZ2VFdmVyIEZvcmsgQ29kZSBTaWduaW5nIChsYXVjaGl3YSkgYmFja3Vw
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAzIfOT3iL0yubRYtEr9hS
23+iHkyV7mDb79htgkeL3saq25tbe2GTBoH1tmiOqRqxTZ1zsoD8vHo2QfpQkQrj
0FixFNs5F8cWOk5ED2ha4frlTjBWQw0B91DHBEnxBXF0dmoqFy3z+YWWDDrt+PU/
wLcJtWmDU4AjbHh94HmoGtPjrEnTof6irtjR+JvBstP3F/xcaqQKU8T8PDctXnKD
laKQ0yqWKfy+7PBTavD+vtbAs/CmxFMOfuVzHzoX1Feqe1YM1/J5QeZjuNdkUYzy
UCauLgyhAdceBGjsnf6muoT3eR6vAbctwAkKMmBJSYPQH2f2GZ/0ualc0hQwtB6f
H4We0rjuaXExIOI4JvTPjdy9FGQAhpqco2qiq9o4fDRi4BMm/lT4Ohf035yIgNoH
edu1MAvdJzaUmXz5gMSq8pIRYUeojCPJbqkn7rlbUIUDR/uww7/nkDuBAh7sUfd8
zYLTSt6rByjt1D3undIJ/VNITrJvQiobGDk6mp6ec3FvAgMBAAGjVzBVMAwGA1Ud
EwEB/wQCMAAwDgYDVR0PAQH/BAQDAgCAMBYGA1UdJQEB/wQMMAoGCCsGAQUFBwMD
MB0GA1UdDgQWBBTpWIvi7XAt9sIpo0x4G/aHeJLLzTANBgkqhkiG9w0BAQsFAAOC
AYEAVhufVSdWqzMCWQkYFzOTQQzzIiTGXsaLHI7kyOFMNUxpFMRdTqMlVf+Qe3zh
tcUWDgRpv0OUaXeZ6/afVzLAtQQ6C4V0wLKVtnPpG4h80V4+sOdREzqKDQrrEiFJ
p4MQtPFN4TKKEUna45lH1lICBfDaEIyrzS1BggXamQ5g94tJC0HzP4vRvAXMbm8M
b53o8qU4gJ52x1kDIWkz7vPUGHpnwN7mk2qEPUoKREIDIcwLK2uVQps4H4XRU21V
0hGDPYqekOBZ2WVKiXzJ2ssXIHqFsSupEtC1Tnk/I1dXnrQzGF6dJq9IghBh7Xjz
vZD1S5s1xWQpC7HYASoGAE8xhiE7g2ebHJ/hMq6aEbynM7M8cmpbI8ERVoDrNZQL
+0PBnued5S3wqWIID6bCQvNtjLvQJlhAe8GXNf+BZLBGxlA+kyW2zsJISm7qhpfK
3Fay628S8XDyymv4bvYYFAu92i36+kGXAbdkj2sP7Lo43cHonoOy8z2vI2/+ZuEy
G79b
-----END CERTIFICATE-----`,
  }),
});

export const forkTrustedWindowsUpdateKeys = () => Object.freeze(Object.fromEntries(
  Object.values(FORK_WINDOWS_UPDATE_KEYS)
    .filter((key) => typeof key.publicKeyPem === "string" && key.publicKeyPem.includes("BEGIN PUBLIC KEY"))
    .map((key) => [key.keyId, key.publicKeyPem]),
));
