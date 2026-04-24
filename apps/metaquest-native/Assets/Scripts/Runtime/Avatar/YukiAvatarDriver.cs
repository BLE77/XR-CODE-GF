using System;
using System.Collections.Generic;
using UnityEngine;
using XRCodingAgent.MetaQuestNative.Networking;
using XRCodingAgent.MetaQuestNative.State;

namespace XRCodingAgent.MetaQuestNative.Avatar
{
    public sealed class YukiAvatarDriver : MonoBehaviour
    {
        [Serializable]
        private struct BlendShapeBinding
        {
            public string Name;
            public int Index;
        }

        [Header("Animator")]
        [SerializeField] private QuestBackendBridge? backendBridge;
        [SerializeField] private Animator? animator;
        [SerializeField] private SkinnedMeshRenderer? faceRenderer;
        [SerializeField] private Transform? lookTarget;
        [SerializeField] private string speakingBool = "IsSpeaking";
        [SerializeField] private string thinkingBool = "IsThinking";
        [SerializeField] private string listeningBool = "IsListening";
        [SerializeField] private string alertBool = "IsAlert";
        [SerializeField] private float mouthOpenSpeed = 10f;
        [SerializeField] private float mouthCloseSpeed = 6f;
        [SerializeField] private float blinkInterval = 4.6f;
        [SerializeField] private BlendShapeBinding[] visemeBindings = Array.Empty<BlendShapeBinding>();
        [SerializeField] private BlendShapeBinding[] blinkBindings = Array.Empty<BlendShapeBinding>();

        private readonly Dictionary<string, int> _shapeMap = new();
        private float _mouthWeight;
        private float _blinkTimer;

        private static readonly int IsSpeakingId = Animator.StringToHash("IsSpeaking");
        private static readonly int IsThinkingId = Animator.StringToHash("IsThinking");
        private static readonly int IsListeningId = Animator.StringToHash("IsListening");
        private static readonly int IsAlertId = Animator.StringToHash("IsAlert");

        private void Awake()
        {
            foreach (var binding in visemeBindings)
            {
                _shapeMap[binding.Name] = binding.Index;
            }

            foreach (var binding in blinkBindings)
            {
                _shapeMap[binding.Name] = binding.Index;
            }
        }

        private void OnEnable()
        {
            if (backendBridge != null)
            {
                backendBridge.StateStore.StateChanged += OnStateChanged;
            }
        }

        private void OnDisable()
        {
            if (backendBridge != null)
            {
                backendBridge.StateStore.StateChanged -= OnStateChanged;
            }
        }

        private void Update()
        {
            if (backendBridge == null)
            {
                return;
            }

            ApplyLookTarget();
            AnimateFace(backendBridge.StateStore.AvatarSignal, Time.deltaTime);
        }

        private void OnStateChanged()
        {
            if (backendBridge == null)
            {
                return;
            }

            var signal = backendBridge.StateStore.AvatarSignal;
            var phase = backendBridge.StateStore.HermesPhase;

            if (animator != null)
            {
                animator.SetBool(IsSpeakingId, signal.Mode == AvatarMode.Speaking);
                animator.SetBool(IsThinkingId, signal.Mode == AvatarMode.Thinking || phase.Tone == HermesSurfaceTone.Working);
                animator.SetBool(IsListeningId, signal.Mode == AvatarMode.Listening);
                animator.SetBool(IsAlertId, phase.Tone == HermesSurfaceTone.Attention);

                if (!string.IsNullOrEmpty(speakingBool)) animator.SetBool(speakingBool, signal.Mode == AvatarMode.Speaking);
                if (!string.IsNullOrEmpty(thinkingBool)) animator.SetBool(thinkingBool, signal.Mode == AvatarMode.Thinking || phase.Tone == HermesSurfaceTone.Working);
                if (!string.IsNullOrEmpty(listeningBool)) animator.SetBool(listeningBool, signal.Mode == AvatarMode.Listening);
                if (!string.IsNullOrEmpty(alertBool)) animator.SetBool(alertBool, phase.Tone == HermesSurfaceTone.Attention);
            }
        }

        private void ApplyLookTarget()
        {
            if (lookTarget == null)
            {
                return;
            }

            var targetPosition = lookTarget.position;
            targetPosition.y = Mathf.Max(targetPosition.y, transform.position.y + 1.35f);
            transform.LookAt(targetPosition);
            var euler = transform.eulerAngles;
            transform.rotation = Quaternion.Euler(0f, euler.y, 0f);
        }

        private void AnimateFace(AvatarSignalState signal, float deltaTime)
        {
            if (faceRenderer == null)
            {
                return;
            }

            var targetMouth = signal.Mode == AvatarMode.Speaking
                ? 32f + Mathf.Abs(Mathf.Sin(Time.time * 8.5f)) * 58f
                : signal.Mode == AvatarMode.Listening
                    ? 10f + Mathf.Abs(Mathf.Sin(Time.time * 3.2f)) * 18f
                    : 0f;

            var speed = targetMouth > _mouthWeight ? mouthOpenSpeed : mouthCloseSpeed;
            _mouthWeight = Mathf.MoveTowards(_mouthWeight, targetMouth, speed * 100f * deltaTime);

            SetShape("A", _mouthWeight);
            SetShape("aa", _mouthWeight);
            SetShape("O", _mouthWeight * 0.35f);
            SetShape("oh", _mouthWeight * 0.35f);
            SetShape("Smile", signal.Mode == AvatarMode.Speaking ? 18f : 4f);
            SetShape("happy", signal.Mode == AvatarMode.Speaking ? 18f : 4f);

            _blinkTimer += deltaTime;
            var blinkWeight = 0f;
            if (_blinkTimer >= blinkInterval)
            {
                blinkWeight = Mathf.Abs(Mathf.Sin((_blinkTimer - blinkInterval) * 24f)) * 100f;
                if (_blinkTimer >= blinkInterval + 0.22f)
                {
                    _blinkTimer = 0f;
                }
            }

            SetShape("Blink", blinkWeight);
            SetShape("blink", blinkWeight);
        }

        private void SetShape(string name, float weight)
        {
            if (faceRenderer == null || !_shapeMap.TryGetValue(name, out var index))
            {
                return;
            }

            if (index < 0 || index >= faceRenderer.sharedMesh.blendShapeCount)
            {
                return;
            }

            faceRenderer.SetBlendShapeWeight(index, weight);
        }
    }
}
