using UnityEngine;

namespace XRCodingAgent.MetaQuestNative.Spatial
{
    public sealed class CompanionPlacementController : MonoBehaviour
    {
        [SerializeField] private Transform? headTransform;
        [SerializeField] private Transform? companionRoot;
        [SerializeField] private LayerMask placementMask = ~0;
        [SerializeField] private float defaultDistance = 1.4f;
        [SerializeField] private float minimumDistance = 0.9f;
        [SerializeField] private float maximumDistance = 2.4f;
        [SerializeField] private float verticalOffset = -0.25f;

        public void PlaceInFrontOfUser()
        {
            if (headTransform == null || companionRoot == null)
            {
                return;
            }

            var origin = headTransform.position;
            var forward = Vector3.ProjectOnPlane(headTransform.forward, Vector3.up).normalized;
            if (forward.sqrMagnitude < 0.001f)
            {
                forward = headTransform.forward.normalized;
            }

            var targetPosition = origin + (forward * defaultDistance);
            targetPosition.y += verticalOffset;

            if (Physics.Raycast(origin, forward, out var hit, maximumDistance, placementMask, QueryTriggerInteraction.Ignore))
            {
                var distance = Mathf.Clamp(hit.distance - 0.3f, minimumDistance, maximumDistance);
                targetPosition = origin + (forward * distance);
                targetPosition.y = hit.point.y;
            }

            companionRoot.position = targetPosition;
            var lookAt = new Vector3(origin.x, companionRoot.position.y, origin.z);
            companionRoot.LookAt(lookAt);
        }
    }
}
