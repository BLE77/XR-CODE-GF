using UnityEngine;

namespace XRCodingAgent.MetaQuestNative.Spatial
{
    public sealed class WorldPanelLayoutController : MonoBehaviour
    {
        [SerializeField] private Transform? companionRoot;
        [SerializeField] private Transform? hermesPanel;
        [SerializeField] private Transform? workerBoardPanel;
        [SerializeField] private Transform? workerDetailPanel;
        [SerializeField] private float sideRadius = 1.15f;
        [SerializeField] private float hermesHeight = 1.35f;
        [SerializeField] private float boardHeight = 1.22f;
        [SerializeField] private float detailHeight = 1.08f;

        public void ApplyLayout()
        {
            if (companionRoot == null)
            {
                return;
            }

            var root = companionRoot.position;
            var forward = Vector3.ProjectOnPlane(companionRoot.forward, Vector3.up).normalized;
            var right = Vector3.Cross(Vector3.up, forward).normalized;

            if (hermesPanel != null)
            {
                hermesPanel.position = root + (forward * 0.82f) + (Vector3.up * hermesHeight);
                hermesPanel.LookAt(new Vector3(root.x, hermesPanel.position.y, root.z));
            }

            if (workerBoardPanel != null)
            {
                workerBoardPanel.position = root + (right * sideRadius) + (forward * 0.18f) + (Vector3.up * boardHeight);
                workerBoardPanel.LookAt(new Vector3(root.x, workerBoardPanel.position.y, root.z));
            }

            if (workerDetailPanel != null)
            {
                workerDetailPanel.position = root - (right * sideRadius) + (forward * 0.25f) + (Vector3.up * detailHeight);
                workerDetailPanel.LookAt(new Vector3(root.x, workerDetailPanel.position.y, root.z));
            }
        }

        private void LateUpdate()
        {
            ApplyLayout();
        }
    }
}
