import * as React from 'react';
import { k8sKill, K8sKind, K8sResourceKind } from '@console/internal/module/k8s';
import {
  createModalLauncher,
  ModalTitle,
  ModalBody,
  ModalSubmitFooter,
  ModalComponentProps,
} from '@console/internal/components/factory/modal';
import { history } from '@console/internal/components/utils';
import {
  ALL_NAMESPACES_KEY,
  useActiveNamespace,
  YellowExclamationTriangleIcon,
} from '@console/shared';
import { usePromiseHandler } from '@console/shared/src/hooks/promise-handler';
import { useTranslation, Trans } from 'react-i18next';

export const DeleteNamespaceModal: React.FC<DeleteNamespaceModalProps> = ({
  cancel,
  close,
  kind,
  resource,
}) => {
  const [activeNamespace, setActiveNamespace] = useActiveNamespace();
  const [handlePromise, inProgress, errorMessage] = usePromiseHandler();
  const [confirmed, setConfirmed] = React.useState(false);
  const onSubmit = (event) => {
    event.preventDefault();
    handlePromise(k8sKill(kind, resource))
      .then(() => {
        if (resource.metadata.name === activeNamespace) {
          setActiveNamespace(ALL_NAMESPACES_KEY);
        }
        close?.();
        history.push(`/k8s/cluster/${kind.plural}`);
      })
      .catch(() => {
        /* do nothing */
      });
  };

  const onKeyUp = (e) => {
    setConfirmed(e.currentTarget.value === resource.metadata.name);
  };
  const { t } = useTranslation();
  const { name } = resource.metadata;

  return (
    <form onSubmit={onSubmit} name="form" className="modal-content ">
      <ModalTitle className="modal-header">
        <YellowExclamationTriangleIcon className="co-icon-space-r" />{' '}
        {t('modal~Delete {{label}}?', kind)}
      </ModalTitle>
      <ModalBody>
        <p>
          <Trans i18nKey="modal~deleteNSWarning">
            This action cannot be undone. It will destroy all Pods, Services and other objects in
            the Namespace <strong className="co-break-word">{{ name }}</strong>.
          </Trans>
        </p>
        <p>
          <Trans i18nKey="modal~deleteNSConfirm">
            Confirm deletion by typing <strong className="co-break-word">{{ name }}</strong> below:
          </Trans>
        </p>
        <input
          type="text"
          data-test="project-name-input"
          className="pf-c-form-control"
          onKeyUp={onKeyUp}
          placeholder={t('modal~Enter name')}
          aria-label={t('modal~Enter the name of the {{label}} to delete', kind)}
          autoFocus={true}
        />
      </ModalBody>
      <ModalSubmitFooter
        submitText={t('modal~Delete')}
        submitDisabled={!confirmed}
        cancel={() => cancel?.()}
        errorMessage={errorMessage}
        inProgress={inProgress}
        submitDanger
      />
    </form>
  );
};

export const deleteNamespaceModal = createModalLauncher(DeleteNamespaceModal);

type DeleteNamespaceModalProps = {
  resource: K8sResourceKind;
  kind: K8sKind;
} & ModalComponentProps;
