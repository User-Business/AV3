import { exigirPermissao, type Ator } from '../domain/autorizacao.js';
import { cnpjValido, normalizarCnpj } from '../domain/cnpj.js';
import { Contrato, paraDataSemHora, type DadosContrato } from '../domain/contrato.js';
import { ErroConflito, ErroNaoEncontrado, ErroRegraNegocio, ErroValidacao } from '../domain/erros.js';
import type { UnidadeDeTrabalho, Repositorios } from '../repositories/index.js';
import type { OrganizacaoComContrato } from '../repositories/organizacao.repository.js';
import { contratoDTO, contratoParaDominio, organizacaoDTO } from './dto.js';

export interface DadosNovaOrganizacao {
  codigo: string;
  razaoSocial: string;
  cnpj: string;
  inscricaoEstadual?: string;
  enderecoCompleto: string;
  telefone?: string;
  email: string;
  contrato?: DadosContrato;
}

export class OrganizacaoService {
  constructor(private readonly uow: UnidadeDeTrabalho) {}

  /** Cadastro da organização e (opcionalmente) do contrato numa única transação. */
  async cadastrar(ator: Ator, dados: DadosNovaOrganizacao) {
    exigirPermissao(ator, 'organizacao:escrever');

    const cnpj = normalizarCnpj(dados.cnpj);
    if (!cnpjValido(cnpj)) throw new ErroValidacao(`CNPJ inválido: ${dados.cnpj}`);
    const codigo = dados.codigo.trim().toUpperCase();
    const contrato = dados.contrato ? Contrato.criar(dados.contrato) : null;

    // Checagem amigável. A garantia real é o índice UNIQUE no banco: se duas
    // requisições passarem daqui ao mesmo tempo, a segunda recebe P2002 -> 409.
    if (await this.uow.leitura.organizacoes.buscarPorCnpj(cnpj)) {
      throw new ErroConflito(`Já existe organização com o CNPJ ${cnpj}`);
    }
    if (await this.uow.leitura.organizacoes.buscarPorCodigo(codigo)) {
      throw new ErroConflito(`Já existe organização com o código ${codigo}`);
    }

    return this.uow.emTransacao(async (repos) => {
      const criada = await repos.organizacoes.criar({
        codigo,
        razaoSocial: dados.razaoSocial.trim(),
        cnpj,
        inscricaoEstadual: dados.inscricaoEstadual?.trim() || null,
        enderecoCompleto: dados.enderecoCompleto.trim(),
        telefone: dados.telefone?.trim() || null,
        email: dados.email.trim().toLowerCase(),
        ...(contrato ? { contrato: { create: dadosPersistenciaContrato(contrato) } } : {}),
      });
      const dto = organizacaoDTO(criada);
      await repos.historico.registrarJournal({
        operacao: 'CRIAR',
        entidade: 'Organizacao',
        entidadeId: criada.id,
        dadosDepois: dto,
        usuarioResponsavel: ator.usuario,
      });
      return dto;
    });
  }

  async buscar(ator: Ator, idOuCodigo: string) {
    exigirPermissao(ator, 'organizacao:ler');
    return organizacaoDTO(await this.obter(this.uow.leitura, idOuCodigo));
  }

  async listar(ator: Ator, filtro: { ativo?: boolean }) {
    exigirPermissao(ator, 'organizacao:ler');
    return (await this.uow.leitura.organizacoes.listar(filtro)).map(organizacaoDTO);
  }

  async alterarEndereco(ator: Ator, id: string, versao: number, novoEndereco: string) {
    exigirPermissao(ator, 'organizacao:escrever');
    const endereco = novoEndereco.trim();
    if (endereco.length < 10) throw new ErroValidacao('Endereço muito curto');

    return this.uow.emTransacao(async (repos) => {
      const antes = await this.obter(repos, id);
      if (!antes.ativo) throw new ErroRegraNegocio('Organização inativa não pode ser alterada');
      await repos.organizacoes.atualizar(antes.id, versao, { enderecoCompleto: endereco });
      const depois = organizacaoDTO(await this.obter(repos, antes.id));
      await repos.historico.registrarJournal({
        operacao: 'ALTERAR_ENDERECO',
        entidade: 'Organizacao',
        entidadeId: antes.id,
        dadosAntes: { enderecoCompleto: antes.enderecoCompleto },
        dadosDepois: { enderecoCompleto: depois.enderecoCompleto },
        usuarioResponsavel: ator.usuario,
      });
      return depois;
    });
  }

  async desativar(ator: Ator, id: string, versao: number) {
    exigirPermissao(ator, 'organizacao:escrever');
    return this.uow.emTransacao(async (repos) => {
      const org = await this.obter(repos, id);
      if (!org.ativo) throw new ErroRegraNegocio('Organização já está inativa');
      const abertos = await repos.organizacoes.contarLotesEmAberto(org.id);
      if (abertos > 0) {
        throw new ErroRegraNegocio(`A organização possui ${abertos} lote(s) não finalizado(s)`);
      }
      await repos.organizacoes.atualizar(org.id, versao, { ativo: false });
      await repos.historico.registrarJournal({
        operacao: 'DESATIVAR',
        entidade: 'Organizacao',
        entidadeId: org.id,
        dadosAntes: { ativo: true },
        dadosDepois: { ativo: false },
        usuarioResponsavel: ator.usuario,
      });
      return organizacaoDTO(await this.obter(repos, org.id));
    });
  }

  /** Organização possui Contrato opcional (0..1): só cria se ainda não houver. */
  async definirContrato(ator: Ator, organizacaoId: string, dados: DadosContrato) {
    exigirPermissao(ator, 'organizacao:escrever');
    const contrato = Contrato.criar(dados);

    return this.uow.emTransacao(async (repos) => {
      const org = await this.obter(repos, organizacaoId);
      if (org.contrato) {
        throw new ErroConflito('A organização já possui contrato; utilize a renovação');
      }
      const criado = await repos.contratos.criar({ organizacaoId: org.id, ...dadosPersistenciaContrato(contrato) });
      const dto = contratoDTO(criado);
      await repos.historico.registrarJournal({
        operacao: 'CRIAR',
        entidade: 'Contrato',
        entidadeId: criado.id,
        dadosDepois: dto,
        usuarioResponsavel: ator.usuario,
      });
      return dto;
    });
  }

  async renovarContrato(ator: Ator, organizacaoId: string, versao: number, novoVencimento: string) {
    exigirPermissao(ator, 'organizacao:escrever');

    return this.uow.emTransacao(async (repos) => {
      const org = await this.obter(repos, organizacaoId);
      if (!org.contrato) throw new ErroNaoEncontrado('Contrato da organização', organizacaoId);
      const contrato = contratoParaDominio(org.contrato);
      const vencimentoAnterior = contrato.valores.dataVencimento;
      contrato.renovar(novoVencimento);

      await repos.contratos.atualizar(org.contrato.id, versao, {
        dataVencimento: paraDataSemHora(contrato.valores.dataVencimento),
      });
      await repos.historico.registrarJournal({
        operacao: 'RENOVAR',
        entidade: 'Contrato',
        entidadeId: org.contrato.id,
        dadosAntes: { dataVencimento: vencimentoAnterior },
        dadosDepois: { dataVencimento: contrato.valores.dataVencimento },
        usuarioResponsavel: ator.usuario,
      });
      return contratoDTO((await repos.contratos.buscarPorOrganizacao(org.id))!);
    });
  }

  private async obter(repos: Repositorios, idOuCodigo: string): Promise<OrganizacaoComContrato> {
    const ehUuid = /^[0-9a-f-]{36}$/i.test(idOuCodigo);
    const org = ehUuid
      ? await repos.organizacoes.buscarPorId(idOuCodigo)
      : await repos.organizacoes.buscarPorCodigo(idOuCodigo.toUpperCase());
    if (!org) throw new ErroNaoEncontrado('Organização', idOuCodigo);
    return org;
  }
}

function dadosPersistenciaContrato(contrato: Contrato) {
  const v = contrato.valores;
  return {
    dataAssinatura: paraDataSemHora(v.dataAssinatura),
    dataVencimento: paraDataSemHora(v.dataVencimento),
    clausulas: v.clausulas,
    valorMensal: v.valorMensal,
    renovacaoAutomatica: v.renovacaoAutomatica,
  };
}
